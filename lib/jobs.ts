import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JOBS_DIR, childEnv, scriptPath } from "./config";
import { stripAnsi } from "./script";

// Every action runs the script detached, in its own process group, with its output going to a
// file. Stopping or restarting this server never stops a frontend, a backend or a half-done
// remove, and the exit code still lands in <id>.exit because the wrapping sh writes it there.

export type Action = "restart-frontend" | "restart-backend" | "remove" | "launch";

export type JobMeta = { id: string; ticket: string; action: Action; args: string[]; pid: number; startedAt: number };

export type JobState = JobMeta & {
  status: "running" | "ok" | "failed" | "lost";
  exitCode: number | null;
  text: string;
  offset: number;
  refusedDirty: boolean;
};

const ID_RE = /^\d+-\d+-[a-z-]+$/;
const KEEP_MS = 2 * 24 * 3600 * 1000;
const DIRTY_REFUSAL = "has uncommitted changes — commit them or pass --force";

const file = (id: string, ext: "json" | "log" | "exit") => path.join(/*turbopackIgnore: true*/ JOBS_DIR, `${id}.${ext}`);

function alive(pid: number): boolean {
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
  const meta: JobMeta = { id, ticket, action, args, pid: child.pid ?? -1, startedAt: Date.now() };
  fs.writeFileSync(file(id, "json"), JSON.stringify(meta));
  return meta;
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
    return { text: stripAnsi(buf.toString("utf8")), offset: size };
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
  try {
    exitCode = parseInt(fs.readFileSync(file(id, "exit"), "utf8").trim(), 10);
  } catch {}
  const status =
    exitCode !== null ? (exitCode === 0 ? "ok" : "failed") : alive(meta.pid) ? "running" : "lost";
  const { text, offset: next } = readFrom(file(id, "log"), offset);
  // Judged on the whole log, not just the new chunk, so a refusal is never missed between polls.
  const refusedDirty =
    meta.action === "remove" && status === "failed" && readFrom(file(id, "log"), 0).text.includes(DIRTY_REFUSAL);
  return { ...meta, status, exitCode, text, offset: next, refusedDirty };
}

export function runningJobs(): JobState[] {
  let names: string[];
  try {
    names = fs.readdirSync(JOBS_DIR);
  } catch {
    return [];
  }
  const out: JobState[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.slice(0, -5);
    const job = readJob(id, Number.MAX_SAFE_INTEGER);
    if (!job) continue;
    if (job.status === "running") out.push(job);
    else if (Date.now() - job.startedAt > KEEP_MS) {
      for (const ext of ["json", "log", "exit"] as const) fs.rmSync(file(id, ext), { force: true });
    }
  }
  return out;
}

export const runningJobFor = (ticket: string) => runningJobs().find((j) => j.ticket === ticket);
