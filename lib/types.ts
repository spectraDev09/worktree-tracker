// Shapes shared by the server routes and the page. No node imports: the page bundles this.

export type Repo = { name: string; branch: string | null; dirty: boolean | null };

// One entry of `grubbs-worktree.sh ls --json`.
export type Worktree = {
  ticket: string;
  path: string | null;
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

export type Action =
  | "launch"
  | "start"
  | "stop"
  | "stop-frontend"
  | "stop-backend"
  | "restart-frontend"
  | "restart-backend"
  | "remove";

export type JobStatus = "running" | "ok" | "failed" | "lost";

export type JobMeta = {
  id: string;
  ticket: string;
  action: Action;
  args: string[];
  pid: number;
  startedAt: number;
  bootAt?: number; // when the machine booted; a job from an earlier boot cannot still be running
};

export type JobState = JobMeta & {
  status: JobStatus;
  exitCode: number | null;
  finishedAt: number | null;
  text: string;
  offset: number;
  refusedDirty: boolean;
};

// The last launch of a ticket, kept for the worktree's lifetime so its receipt survives a reload.
export type LaunchSummary = {
  id: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  args: string[];
  warnings: string[];
  error: string | null;
};

export type WorktreeView = Worktree & { apiAnswering: boolean; lastLaunch: LaunchSummary | null };

export type ListResponse = {
  docker: boolean;
  git: boolean;
  worktrees: WorktreeView[];
  jobs: JobState[];
  checkedAt: number;
};

export type Ports = { fePort: number; webPort: number; pgPort: number };

export type Capabilities = { t3: boolean; editor: string | null; terminal: string | null };

export type RevealApp = "t3" | "terminal" | "editor" | "finder";
