import { useEffect, useState } from "react";
import type { Action, JobState, WorktreeView } from "@/lib/types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-grubbs-worktrees": "1", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
}

export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const tail = (text: string, lines = 15) => text.trimEnd().split("\n").slice(-lines).join("\n");

export const lastLine = (text: string) => {
  const lines = text.split("\n").map((l) => l.slice(l.lastIndexOf("\r") + 1).trim()).filter(Boolean);
  return lines.at(-1)?.replace(/^==> /, "") ?? "";
};

// The stack's credentials are the compose file's dev defaults, printed by launch-worktree too.
export const psqlUrl = (w: WorktreeView) => `postgresql://admin:admin@localhost:${w.pgPort}/grubbs_db`;

export const envBlock = (w: WorktreeView) =>
  [`FE_URL=${w.feUrl}`, `API_URL=${w.apiUrl}`, `DATABASE_URL=${psqlUrl(w)}`].join("\n");

export const hostOf = (url: string | null) => (url ? url.replace(/^https?:\/\//, "").replace(/:\d+$/, "") : "");

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function useNow(everyMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs, active]);
  return now;
}

// What a socket shows. "busy": a job is changing this service right now.
export type Svc = "live" | "starting" | "stopped" | "unknown" | "busy";

const TOUCHES: Record<Action, ("app" | "api" | "db")[]> = {
  launch: ["app", "api", "db"],
  start: ["app", "api", "db"],
  stop: ["app", "api", "db"],
  remove: ["app", "api", "db"],
  "restart-frontend": ["app"],
  "stop-frontend": ["app"],
  "restart-backend": ["api"],
  "stop-backend": ["api", "db"],
};

export function services(w: WorktreeView, docker: boolean | null, job?: JobState) {
  const busy = job?.status === "running" ? TOUCHES[job.action] : [];
  const backend = (up: boolean): Svc => (docker === false ? "unknown" : w.containersRunning <= 0 ? "stopped" : up ? "live" : "starting");
  const s = {
    app: (w.frontendUp ? "live" : "stopped") as Svc,
    api: backend(w.apiAnswering),
    db: backend(true),
  };
  for (const k of busy) s[k] = "busy";
  return s;
}

export const isRunning = (w: WorktreeView) => w.frontendUp || w.containersRunning > 0;

export const ACTION_LABEL: Record<Action, string> = {
  launch: "Launching",
  start: "Starting",
  stop: "Stopping",
  "stop-frontend": "Stopping frontend",
  "stop-backend": "Stopping backend",
  "restart-frontend": "Restarting frontend",
  "restart-backend": "Restarting backend",
  remove: "Removing",
};

export const ACTION_DONE: Record<Action, string> = {
  launch: "launched",
  start: "is up",
  stop: "stopped",
  "stop-frontend": "frontend stopped",
  "stop-backend": "backend stopped",
  "restart-frontend": "frontend restarted",
  "restart-backend": "backend restarted",
  remove: "removed",
};
