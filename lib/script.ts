import { execFile } from "node:child_process";
import { childEnv, scriptPath } from "./config";

export type Repo = { name: string; branch: string | null; dirty: boolean | null };

export type Worktree = {
  ticket: string;
  branch: string | null;
  project: string | null;
  feUrl: string | null;
  apiUrl: string | null;
  fePort: number | null;
  webPort: number | null;
  pgPort: number | null;
  frontendUp: boolean;
  containersRunning: number;
  repos: Repo[];
};

export type RunResult = { code: number; stdout: string; stderr: string };

// next dev and docker write colour codes and cursor controls into their logs
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function run(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: childEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
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

export async function dockerUp(): Promise<boolean> {
  const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 8_000);
  return r.code === 0 && r.stdout.trim() !== "";
}

// Any HTTP status means the API is answering; only a connection failure or timeout counts as down.
export async function apiAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}
