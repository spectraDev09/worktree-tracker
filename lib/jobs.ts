import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JOBS_DIR, childEnv, scriptPath } from "./config";
import { stripAnsi } from "./script";
import { parseLaunch } from "./stages";
import type { Action, JobMeta, JobState, LaunchSummary } from "./types";

// Every action runs the script detached, in its own process group, with its output going to a
// file. Stopping or restarting this server never stops a frontend, a backend or a half-done
// remove, and the exit code still lands in <id>.exit because the wrapping sh writes it there.
//
// Finished jobs go after two days, except each ticket's newest launch: that is the worktree's
// receipt, kept until the worktree itself is gone.

const ID_RE = /^\d+-\d+-[a-z-]+$/;
const KEEP_MS = 2 * 24 * 3600 * 1000;
const DIRTY_REFUSAL = "has uncommitted changes — commit them or pass --force";

const file = (id: string, ext: "json" | "log" | "exit") => path.join(/*turbopackIgnore: true*/ JOBS_DIR, `${id}.${ext}`);

// To the second or so: uptime and the clock are read at slightly different moments.
const bootAt = () => Date.now() - os.uptime() * 1000;

// A pid from before a reboot may belong to anything now, so a job from an earlier boot is never alive.
function alive(meta: JobMeta): boolean {
  const pid = meta.pid;
  if (!(pid > 0)) return false;
  if (meta.bootAt !== undefined && Math.abs(bootAt() - meta.bootAt) > 120_000) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function startJob(ticket: string, action: Action, args: string[]): JobMeta {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const id = `${Date.now()}-${ticket}-${action}`;
  const out = fs.openSync(file(id, "log"), "a");
  // The -c string is constant; the script path and every argument travel as argv.
  const child = spawn("/bin/sh", ["-c", '"$0" "$@"; echo $? > "$GW_EXIT_FILE"', scriptPath(), ...args], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: os.homedir(),
    env: childEnv({ GW_EXIT_FILE: file(id, "exit") }),
  });
  child.unref();
  fs.closeSync(out);
  const meta: JobMeta = { id, ticket, action, args, pid: child.pid ?? -1, startedAt: Date.now(), bootAt: bootAt() };
  fs.writeFileSync(file(id, "json"), JSON.stringify(meta));
  return meta;
}

// How much of buf ends on a whole character and a whole escape sequence. The rest waits for the
// next read, so a "→" or a colour code split across two polls is never decoded in halves.
function whole(buf: Buffer): number {
  let end = buf.length;
  for (let i = buf.length - 1, k = 1; i >= 0 && k <= 4; i--, k++) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (k < need) end = i;
    break;
  }
  // only an escape that may still become a colour code, i.e. one with no final byte yet
  const esc = buf.lastIndexOf(0x1b, end - 1);
  if (esc >= 0 && /^\x1b(\[[0-9;?]*[ -/]*)?$/.test(buf.toString("latin1", esc, end))) end = esc;
  return end;
}

function readFrom(p: string, offset: number): { text: string; offset: number } {
  let fd: number;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return { text: "", offset };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: "", offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const end = whole(buf);
    return { text: stripAnsi(buf.toString("utf8", 0, end)), offset: offset + end };
  } finally {
    fs.closeSync(fd);
  }
}

export function readJob(id: string, offset = 0): JobState | null {
  if (!ID_RE.test(id)) return null;
  let meta: JobMeta;
  try {
    meta = JSON.parse(fs.readFileSync(file(id, "json"), "utf8"));
  } catch {
    return null;
  }
  let exitCode: number | null = null;
  let finishedAt: number | null = null;
  try {
    exitCode = parseInt(fs.readFileSync(file(id, "exit"), "utf8").trim(), 10);
    finishedAt = fs.statSync(file(id, "exit")).mtimeMs;
  } catch {}
  const status =
    exitCode !== null ? (exitCode === 0 ? "ok" : "failed") : alive(meta) ? "running" : "lost";
  const { text, offset: next } = readFrom(file(id, "log"), offset);
  // Judged on the whole log, not just the new chunk, so a refusal is never missed between polls.
  const refusedDirty =
    meta.action === "remove" && status === "failed" && readFrom(file(id, "log"), 0).text.includes(DIRTY_REFUSAL);
  return { ...meta, status, exitCode, finishedAt, text, offset: next, refusedDirty };
}

function allJobs(): JobState[] {
  let names: string[];
  try {
    names = fs.readdirSync(JOBS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJob(n.slice(0, -5), Number.MAX_SAFE_INTEGER))
    .filter((j): j is JobState => j !== null);
}

const newestLaunches = (jobs: JobState[]) => {
  const out = new Map<string, JobState>();
  for (const j of jobs) {
    if (j.action !== "launch") continue;
    const prev = out.get(j.ticket);
    if (!prev || j.startedAt > prev.startedAt) out.set(j.ticket, j);
  }
  return out;
};

export const runningJobs = () => allJobs().filter((j) => j.status === "running");

export const runningJobFor = (ticket: string) => runningJobs().find((j) => j.ticket === ticket);

// A finished launch's log never changes, so it is parsed once.
const summaries = new Map<string, LaunchSummary>();

function summarize(j: JobState): LaunchSummary {
  const hit = summaries.get(j.id);
  if (hit && hit.status === j.status) return hit;
  const text = readJob(j.id, 0)?.text ?? "";
  const v = parseLaunch(text, j.status, j.args.includes("--no-start"));
  const summary: LaunchSummary = {
    id: j.id,
    status: j.status,
    exitCode: j.exitCode,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    args: j.args,
    warnings: v.warnings,
    error: v.stages.find((s) => s.state === "failed")?.warning ?? v.error,
  };
  if (j.status !== "running") summaries.set(j.id, summary);
  return summary;
}

// Running jobs and each live ticket's newest launch; clears out what is no longer needed.
export function scanJobs(liveTickets: Set<string>): { running: JobState[]; launches: Record<string, LaunchSummary> } {
  const jobs = allJobs();
  const newest = newestLaunches(jobs);
  const launches: Record<string, LaunchSummary> = {};
  for (const [ticket, j] of newest) if (liveTickets.has(ticket)) launches[ticket] = summarize(j);
  for (const j of jobs) {
    const receipt = newest.get(j.ticket) === j && liveTickets.has(j.ticket);
    if (j.status === "running" || receipt || Date.now() - j.startedAt <= KEEP_MS) continue;
    for (const ext of ["json", "log", "exit"] as const) fs.rmSync(file(j.id, ext), { force: true });
    summaries.delete(j.id);
  }
  return { running: jobs.filter((j) => j.status === "running"), launches };
}
