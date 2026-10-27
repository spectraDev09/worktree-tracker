import type { JobStatus } from "./types";

// Reads launch-worktree's output as stages. The script marks each step with a "==> " line (say),
// indents its details by four spaces (note) and ends a failure with "error: …" (die). Nothing
// here changes the script; a line it does not recognise just becomes the stage's latest line.

export type StageKey = "ports" | "worktrees" | "env" | "claude" | "t3" | "snapshot" | "backend" | "frontend";
export type StageState = "pending" | "active" | "done" | "warn" | "failed" | "skipped";

export type Stage = {
  key: StageKey;
  label: string;
  state: StageState;
  detail: string | null; // short fact for the right-hand column: "slot 5", "267 tables"
  last: string | null; // the stage's latest output line, shown while it runs
  warning: string | null;
};

export type LaunchView = {
  stages: Stage[];
  current: number; // index of the furthest stage reached, -1 before the first
  finished: "up" | "ready" | null; // "ready": --no-start, nothing was started
  error: string | null;
  ports: { fe: number; web: number; pg: number } | null;
  fruit: { db: boolean; api: boolean; app: boolean };
  warnings: string[];
  progress: number; // 0..1
};

const STAGES: { key: StageKey; label: string; say?: RegExp }[] = [
  { key: "ports", label: "Reserve ports", say: /^grubbs-\d+ → / },
  { key: "worktrees", label: "Create 3 worktrees", say: /^worktrees on / },
  { key: "env", label: "Copy env files", say: /^env files$/ },
  { key: "claude", label: "Link Claude setup", say: /^Claude setup$/ },
  { key: "t3", label: "Add to T3 Code", say: /^T3 Code$/ },
  { key: "snapshot", label: "Database snapshot", say: /^building the database snapshot/ },
  { key: "backend", label: "Postgres, restore, migrations", say: /^backend stack / },
  { key: "frontend", label: "Frontend: next dev", say: /^frontend$/ },
];

const at = (key: StageKey) => STAGES.findIndex((s) => s.key === key);
const SNAPSHOT = at("snapshot");
const T3 = at("t3");
const NO_START_LAST = T3; // --no-start stops after the T3 step

export function parseLaunch(text: string, status: JobStatus, noStart = false): LaunchView {
  const stages: Stage[] = STAGES.map((s) => ({ key: s.key, label: s.label, state: "pending", detail: null, last: null, warning: null }));
  let current = -1;
  let finished: LaunchView["finished"] = null;
  let error: string | null = null;
  let ports: LaunchView["ports"] = null;
  let t3Http: string | null = null;
  let t3Skipped = false;
  const fruit = { db: false, api: false, app: false };
  const enter = (i: number) => {
    if (i > current) current = i;
  };
  const warn = (i: number, why: string) => {
    if (i >= 0 && !stages[i].warning) stages[i].warning = why;
  };

  for (const raw of text.split("\n")) {
    // pnpm redraws its progress line with \r; only the last redraw is real
    const line = raw.slice(raw.lastIndexOf("\r") + 1).trimEnd();
    if (!line.trim()) continue;

    const say = /^==> (.*)$/.exec(line)?.[1];
    if (say !== undefined) {
      if (/^grubbs-\d+ is up$/.test(say)) finished = "up";
      else if (/^grubbs-\d+ is ready, nothing started/.test(say)) finished = "ready";
      else {
        const i = STAGES.findIndex((s) => s.say?.test(say));
        if (i >= 0) enter(i);
        const branch = /^worktrees on (\S+)/.exec(say)?.[1];
        if (branch) stages[i].detail = branch;
      }
      continue;
    }
    if (finished) continue; // the closing summary: URLs the page shows on its own
    const err = /^error: (.*)$/.exec(line)?.[1];
    if (err !== undefined) {
      error = err;
      continue;
    }
    if (current < 0) continue;

    const http = /HTTPError: HTTP Error (\d+)/.exec(line)?.[1];
    if (http) t3Http = http;

    const note = /^ {4}(\S.*)$/.exec(line)?.[1];
    let m: RegExpExecArray | null;
    if (note) {
      if ((m = /^ports: frontend (\d+), backend (\d+), postgres (\d+)/.exec(note))) {
        ports = { fe: +m[1], web: +m[2], pg: +m[3] };
        stages[current].detail = `slot ${ports.fe - 3020}`;
      } else if ((m = /^database snapshot: (\S+)/.exec(note))) {
        enter(SNAPSHOT); // printed by the T3 step's successor without a "==>" of its own
        stages[SNAPSHOT].detail = m[1].replace(/\.dump$/, "");
      } else if ((m = /^snapshot ready: (\S+)/.exec(note))) {
        stages[SNAPSHOT].detail = m[1].replace(/\.dump$/, "");
      } else if ((m = /^(?:restored|database already has) (\d+) tables/.exec(note))) {
        fruit.db = true;
        stages[current].detail = `${m[1]} tables`;
      } else if (/^backend answering on/.test(note)) {
        fruit.api = true;
      } else if (/^(?:started on|already running on|listening on) :\d+/.test(note)) {
        fruit.app = true;
      } else if (/^not listening yet/.test(note)) {
        warn(current, "next dev was not listening yet when the launch finished");
      } else if (/^could not add .* to T3 Code/.test(note)) {
        warn(T3, "T3 Code project not added");
      } else if (/^T3 Code is not open/.test(note)) {
        warn(T3, "T3 Code was not open, so the project was not added");
      } else if (/^T3 Code not installed/.test(note)) {
        t3Skipped = true;
      } else if (note.startsWith("!! ")) {
        warn(current, note.slice(3));
      }
    }
    stages[current].last = line.trim().slice(0, 200);
  }

  if (ports) {
    stages[at("backend")].detail ??= `:${ports.web}`;
    stages[at("frontend")].detail = `:${ports.fe}`;
  }
  if (t3Http && stages[T3].warning === "T3 Code project not added") stages[T3].warning += ` (HTTP ${t3Http})`;

  const running = status === "running";
  const ok = finished !== null || status === "ok";
  if (!running && !ok && current >= 0) {
    stages[current].warning = error ?? (status === "lost" ? "stopped without an exit code" : "failed");
  }
  stages.forEach((s, i) => {
    if (i < current) s.state = s.warning ? "warn" : "done";
    else if (i === current) s.state = running ? "active" : ok ? (s.warning ? "warn" : "done") : "failed";
    else s.state = ok ? "skipped" : "pending";
  });
  if (t3Skipped && stages[T3].state === "done") stages[T3].state = "skipped";

  const total = noStart ? NO_START_LAST + 1 : stages.length;
  const progress = ok ? 1 : Math.min(1, Math.max(0, current) / total);
  const warnings = stages.filter((s) => s.warning && s.state === "warn").map((s) => s.warning!);
  return { stages, current, finished, error, ports, fruit, warnings, progress };
}
