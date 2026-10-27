import { execFile } from "node:child_process";
import { childEnv, scriptPath } from "./config";
import type { Ports, Worktree } from "./types";

export type RunResult = { code: number; stdout: string; stderr: string };

// next dev and docker write colour codes and cursor controls into their logs
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function run(file: string, args: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: childEnv(env), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const killed = err && (err as { killed?: boolean }).killed;
        resolve({
          code,
          stdout: stripAnsi(String(stdout)),
          stderr: stripAnsi(String(stderr)) + (killed ? `\n(timed out after ${timeoutMs / 1000}s)` : ""),
        });
      },
    );
  });
}

export const runScript = (args: string[], timeoutMs = 30_000) => run(scriptPath(), args, timeoutMs);

export async function listWorktrees(opts: { git: boolean; ticket?: string }): Promise<Worktree[]> {
  const args = ["ls", "--json"];
  if (!opts.git) args.push("--no-git");
  if (opts.ticket) args.push(opts.ticket);
  const r = await runScript(args, 60_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `worktree ls exited ${r.code}`);
  return JSON.parse(r.stdout) as Worktree[];
}

// The slot launch-worktree would give a new ticket right now. Nothing is reserved by asking.
export async function nextPorts(): Promise<Ports> {
  const r = await runScript(["next-ports"], 15_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `next-ports exited ${r.code}`);
  return JSON.parse(r.stdout) as Ports;
}

export async function dockerUp(): Promise<boolean> {
  const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 8_000);
  return r.code === 0 && r.stdout.trim() !== "";
}

// Tags the probe in the API's access log, so the log view can leave these lines out.
export const PROBE_QUERY = "worktrees-probe";

// Any HTTP status means the API is answering; only a connection failure or timeout counts as down.
export async function apiAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/?${PROBE_QUERY}`, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}
