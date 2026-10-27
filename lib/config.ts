import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

// A launchd agent (or anything started outside a terminal) gets a minimal PATH. docker lives in
// /usr/local/bin, python3 (needed by the script) in /opt/homebrew/bin, the commands in ~/.local/bin.
export const CHILD_PATH = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  path.join(HOME, ".local/bin"),
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

// Children get a terminal-like environment, not this server's: `next start` sets NODE_ENV=production
// (and its own __NEXT_* vars), which would make pnpm skip devDependencies and next dev misbehave.
const PASS = new Set(["USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SSH_AUTH_SOCK", "DOCKER_HOST", "DOCKER_CONTEXT", "NODE20_BIN"]);
const PASS_PREFIX = ["GRUBBS_", "CRM_WT_", "T3_", "T3CODE_"];

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = { LANG: "en_US.UTF-8" };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (PASS.has(k) || PASS_PREFIX.some((p) => k.startsWith(p)))) env[k] = v;
  }
  return { ...env, PATH: CHILD_PATH, HOME, ...extra } as unknown as NodeJS.ProcessEnv;
}

// grubbs-worktree.sh is the source of truth. Call it through the path ~/.local/bin/launch-worktree
// points at (one level, as the script resolves itself), so the script computes the same workspace
// root it does from a terminal.
export function scriptPath(): string {
  if (process.env.GRUBBS_WT_SCRIPT) return process.env.GRUBBS_WT_SCRIPT;
  const link = path.join(HOME, ".local/bin/launch-worktree");
  const target = fs.readlinkSync(link);
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(link), target);
}

export const STATE_DIR = path.join(HOME, "Library/Application Support/Grubbs Worktrees");
export const JOBS_DIR = path.join(STATE_DIR, "jobs");

export const TICKET_RE = /^\d+$/;
