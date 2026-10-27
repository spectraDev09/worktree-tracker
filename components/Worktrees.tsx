"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Repo = { name: string; branch: string | null; dirty: boolean | null };
type Worktree = {
  ticket: string;
  branch: string | null;
  project: string | null;
  feUrl: string | null;
  apiUrl: string | null;
  fePort: number | null;
  webPort: number | null;
  frontendUp: boolean;
  containersRunning: number;
  apiAnswering: boolean;
  repos: Repo[];
};
type Action = "restart-frontend" | "restart-backend" | "remove" | "launch";
type JobState = {
  id: string;
  ticket: string;
  action: Action;
  status: "running" | "ok" | "failed" | "lost";
  exitCode: number | null;
  text: string;
  offset: number;
  refusedDirty: boolean;
};
type ListResponse = { docker: boolean; git: boolean; worktrees: Worktree[]; jobs: JobState[]; checkedAt: number };
type LogsView = { ticket: string; which: "frontend" | "backend"; text: string; loading: boolean; error?: string };
type RemoveDialog = {
  ticket: string;
  stage: "confirm" | "force";
  deleteBranches: boolean;
  fresh?: Worktree;
  checking: boolean;
  error?: string;
  typed: string;
};

const FAST_VISIBLE_MS = 5_000;
const FAST_HIDDEN_MS = 30_000;
const GIT_MS = 60_000;
const JOB_POLL_MS = 1_000;

const ACTION_LABEL: Record<Action, string> = {
  "restart-frontend": "Restarting frontend",
  "restart-backend": "Restarting backend",
  remove: "Removing",
  launch: "Launching",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-grubbs-worktrees": "1", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
}

const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

const scrollToEnd = (el: HTMLPreElement | null) => {
  if (el) el.scrollTop = el.scrollHeight;
};

const tail = (text: string, lines = 15) => text.trimEnd().split("\n").slice(-lines).join("\n");

function backendState(w: Worktree, docker: boolean | null): { label: string; tone: string } {
  if (docker === false) return { label: "unknown", tone: "unknown" };
  const n = w.containersRunning;
  if (n <= 0) return { label: "Stopped", tone: "off" };
  if (n < 3) return { label: `Partial ${n}/3`, tone: "warn" };
  return w.apiAnswering ? { label: "Running", tone: "ok" } : { label: "Starting", tone: "warn" };
}

// "Running" for the badge: anything of the worktree is up, i.e. it is using memory or ports.
const isRunning = (w: Worktree) => w.frontendUp || w.containersRunning > 0;

export default function Worktrees() {
  const [list, setList] = useState<Worktree[] | null>(null);
  const [docker, setDocker] = useState<boolean | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dirty, setDirty] = useState<Record<string, string[]>>({});
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogsView | null>(null);
  const [removeDlg, setRemoveDlg] = useState<RemoveDialog | null>(null);
  const [launchInput, setLaunchInput] = useState("");
  const [launchTicket, setLaunchTicket] = useState<string | null>(null);

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const removeOptsRef = useRef<Record<string, boolean>>({}); // ticket -> deleteBranches, for the Force step

  // ---------------------------------------------------------------------------------------------
  // Polling

  const inFlight = useRef({ fast: false, git: false });

  const refresh = useCallback(async (git: boolean) => {
    const kind = git ? "git" : "fast";
    if (inFlight.current[kind]) return;
    inFlight.current[kind] = true;
    if (git) setRefreshing(true);
    try {
      const r = await api<ListResponse>(`/api/worktrees${git ? "?git=1" : ""}`);
      setList(r.worktrees);
      setDocker(r.docker);
      setCheckedAt(r.checkedAt);
      setListError(null);
      if (r.git) {
        setDirty(
          Object.fromEntries(r.worktrees.map((w) => [w.ticket, w.repos.filter((x) => x.dirty).map((x) => x.name)])),
        );
      }
      // Jobs started before a reload, or from another window, still show their spinner.
      const known = jobsRef.current;
      const adopt = r.jobs.filter((j) => known[j.ticket]?.id !== j.id);
      if (adopt.length) {
        setJobs((prev) => {
          const next = { ...prev };
          for (const j of adopt) next[j.ticket] = { ...j, text: "", offset: 0 };
          return next;
        });
      }
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      inFlight.current[kind] = false;
      if (git) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await refresh(false);
        schedule();
      }, document.hidden ? FAST_HIDDEN_MS : FAST_VISIBLE_MS);
    };
    const onVisible = () => {
      if (!document.hidden) refresh(true); // the window opened: the slow git check too
      schedule();
    };
    refresh(true);
    schedule();
    const git = setInterval(() => !document.hidden && refresh(true), GIT_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearTimeout(timer);
      clearInterval(git);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  // Badge on the installed app's Dock icon, and in the title for a plain tab.
  useEffect(() => {
    if (!list) return;
    const n = list.filter(isRunning).length;
    document.title = n ? `(${n}) Grubbs Worktrees` : "Grubbs Worktrees";
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    (n ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
  }, [list]);

  // ---------------------------------------------------------------------------------------------
  // Jobs

  const openForceDialog = useCallback(async (ticket: string) => {
    setRemoveDlg({ ticket, stage: "force", deleteBranches: removeOptsRef.current[ticket] ?? false, checking: true, typed: "" });
    try {
      const fresh = await api<Worktree>(`/api/worktrees/${ticket}`);
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, fresh, checking: false } : d));
    } catch (e) {
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, checking: false, error: (e as Error).message } : d));
    }
  }, []);

  const onJobDone = useCallback(
    (job: JobState) => {
      const ok = job.status === "ok";
      if (job.action === "remove" && ok) {
        setNotice(`grubbs-${job.ticket} removed`);
        setJobs((prev) => {
          const { [job.ticket]: _, ...rest } = prev;
          return rest;
        });
      } else if (job.action === "remove" && job.refusedDirty) {
        setRowError((e) => ({ ...e, [job.ticket]: "Refused: uncommitted changes. Force remove is offered." }));
        openForceDialog(job.ticket);
      } else if (!ok && job.action !== "launch") {
        const why = job.status === "lost" ? "the command stopped without an exit code" : `exit ${job.exitCode}`;
        setRowError((e) => ({ ...e, [job.ticket]: `${ACTION_LABEL[job.action]} failed (${why}):\n${tail(job.text)}` }));
      }
      refresh(true);
    },
    [refresh, openForceDialog],
  );

  useEffect(() => {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      const running = Object.values(jobsRef.current).filter((j) => j.status === "running");
      if (!running.length) return;
      busy = true;
      try {
        for (const j of running) {
          try {
            const s = await api<JobState>(`/api/jobs/${j.id}?offset=${j.offset}`);
            const merged: JobState = { ...s, text: j.text + s.text };
            setJobs((prev) => (prev[j.ticket]?.id === j.id ? { ...prev, [j.ticket]: merged } : prev));
            jobsRef.current = { ...jobsRef.current, [j.ticket]: merged };
            if (s.status !== "running") onJobDone(merged);
          } catch {}
        }
      } finally {
        busy = false;
      }
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [onJobDone]);

  const startAction = useCallback(
    async (ticket: string, action: Action, extra: Record<string, unknown> = {}) => {
      setRowError((e) => {
        const { [ticket]: _, ...rest } = e;
        return rest;
      });
      setNotice(null);
      try {
        const meta = await post<JobState>(
          action === "launch" ? "/api/launch" : `/api/worktrees/${ticket}/actions`,
          action === "launch" ? { ticket } : { action, ...extra },
        );
        const job: JobState = { ...meta, status: "running", exitCode: null, text: "", offset: 0, refusedDirty: false };
        jobsRef.current = { ...jobsRef.current, [ticket]: job };
        setJobs((prev) => ({ ...prev, [ticket]: job }));
      } catch (e) {
        setRowError((err) => ({ ...err, [ticket]: (e as Error).message }));
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------------------------
  // Row actions

  const open = async (ticket: string) => {
    try {
      await post(`/api/worktrees/${ticket}/open`);
    } catch (e) {
      setRowError((err) => ({ ...err, [ticket]: (e as Error).message }));
    }
  };

  const showLogs = async (ticket: string, which: "frontend" | "backend") => {
    setLogs({ ticket, which, text: "", loading: true });
    try {
      const r = await api<{ text: string }>(`/api/worktrees/${ticket}/logs?which=${which}`);
      setLogs({ ticket, which, text: r.text, loading: false });
    } catch (e) {
      setLogs({ ticket, which, text: "", loading: false, error: (e as Error).message });
    }
  };

  const askRemove = async (ticket: string) => {
    setRemoveDlg({ ticket, stage: "confirm", deleteBranches: false, checking: true, typed: "" });
    try {
      const fresh = await api<Worktree>(`/api/worktrees/${ticket}`);
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, fresh, checking: false } : d));
    } catch (e) {
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, checking: false, error: (e as Error).message } : d));
    }
  };

  const confirmRemove = (d: RemoveDialog) => {
    removeOptsRef.current[d.ticket] = d.deleteBranches;
    setRemoveDlg(null);
    startAction(d.ticket, "remove", { force: d.stage === "force", deleteBranches: d.deleteBranches });
  };

  const dismissJob = (ticket: string) =>
    setJobs((prev) => {
      const { [ticket]: _, ...rest } = prev;
      return rest;
    });

  // ---------------------------------------------------------------------------------------------
  // Render

  const launchJob = launchTicket ? jobs[launchTicket] : undefined;
  const launchBusy = launchJob?.status === "running";

  return (
    <main>
      <header>
        <h1>
          Grubbs Worktrees
          {list && <span className="count">{list.filter(isRunning).length} running</span>}
        </h1>
        <div className="header-right">
          {checkedAt && <span className="muted small">checked {new Date(checkedAt).toLocaleTimeString()}</span>}
          <button onClick={() => refresh(true)} disabled={refreshing}>
            {refreshing ? <span className="spinner" /> : "↻"} Refresh
          </button>
        </div>
      </header>

      {docker === false && (
        <div className="banner">
          <strong>Docker is not running.</strong> Backend status is unknown and backend actions are disabled
          until Docker Desktop is started.
        </div>
      )}
      {listError && <div className="banner error">Could not list worktrees: {listError}</div>}
      {notice && (
        <div className="banner ok" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {list === null && !listError && (
        <p className="muted center">
          <span className="spinner" /> Loading…
        </p>
      )}
      {list?.length === 0 && (
        <p className="empty">
          No worktrees — run <code>launch-worktree &lt;ticket&gt;</code>
        </p>
      )}

      <ul className="rows">
        {list?.map((w) => {
          const job = jobs[w.ticket];
          const busy = job?.status === "running";
          const be = backendState(w, docker);
          const dirtyRepos = dirty[w.ticket] ?? [];
          const err = rowError[w.ticket];
          return (
            <li key={w.ticket} className={busy ? "row busy" : "row"}>
              <div className="row-top">
                <span className="ticket">#{w.ticket}</span>
                <span className="branch">{w.branch}</span>
                {dirtyRepos.length > 0 && (
                  <span className="badge dirty" title={`Uncommitted changes in ${dirtyRepos.join(", ")}`}>
                    uncommitted: {dirtyRepos.join(", ")}
                  </span>
                )}
                {busy && (
                  <span className="busy-label">
                    <span className="spinner" /> {ACTION_LABEL[job.action]}…
                  </span>
                )}
              </div>
              {w.feUrl && (
                <a
                  className="url"
                  href={w.feUrl}
                  onClick={(e) => {
                    e.preventDefault();
                    open(w.ticket);
                  }}
                >
                  {w.feUrl}
                </a>
              )}
              <div className="status">
                <span className={`dot ${w.frontendUp ? "ok" : "off"}`} />
                Frontend <span className="muted">:{w.fePort}</span> {w.frontendUp ? "up" : "down"}
                <span className={`dot ${be.tone}`} />
                Backend <span className="muted">:{w.webPort}</span> {be.label}
                {docker !== false && <span className="muted"> · {w.containersRunning}/3 containers</span>}
              </div>
              <div className="actions">
                <button onClick={() => open(w.ticket)} disabled={busy || !w.feUrl}>
                  Open
                </button>
                <button onClick={() => startAction(w.ticket, "restart-frontend")} disabled={busy}>
                  Restart frontend
                </button>
                <button
                  onClick={() => startAction(w.ticket, "restart-backend")}
                  disabled={busy || docker === false}
                  title={docker === false ? "Docker is not running" : undefined}
                >
                  Restart backend
                </button>
                <button onClick={() => showLogs(w.ticket, "frontend")} disabled={busy}>
                  Frontend log
                </button>
                <button
                  onClick={() => showLogs(w.ticket, "backend")}
                  disabled={busy || docker === false}
                  title={docker === false ? "Docker is not running" : undefined}
                >
                  Backend log
                </button>
                <button
                  className="danger"
                  onClick={() => askRemove(w.ticket)}
                  disabled={busy || docker === false}
                  title={docker === false ? "Start Docker first, so the containers and the database volume go too" : undefined}
                >
                  Remove
                </button>
              </div>
              {err && <pre className="row-error">{err}</pre>}
              {job && job.action !== "launch" && (job.action === "remove" || job.status === "running") && (
                <div className="output">
                  <pre ref={scrollToEnd}>{job.text || "…"}</pre>
                  {!busy && (
                    <button className="link" onClick={() => dismissJob(w.ticket)}>
                      hide output
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <section className="launch">
        <h2>New worktree</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = launchInput.trim().replace(/^#/, "");
            if (!/^\d+$/.test(t)) {
              setRowError((err) => ({ ...err, launch: "Ticket must be a number" }));
              return;
            }
            setRowError(({ launch: _, ...rest }) => rest);
            setLaunchTicket(t);
            startAction(t, "launch");
          }}
        >
          <input
            value={launchInput}
            onChange={(e) => setLaunchInput(e.target.value)}
            placeholder="ticket, e.g. 2140"
            inputMode="numeric"
            disabled={launchBusy}
          />
          <button type="submit" disabled={launchBusy || !launchInput.trim()}>
            {launchBusy ? <span className="spinner" /> : null} launch-worktree
          </button>
        </form>
        <p className="muted small">
          Creates the worktrees and starts both stacks. The first launch after a migration change rebuilds the
          database snapshot and can take many minutes.
        </p>
        {(rowError.launch || (launchTicket && rowError[launchTicket] && !list?.some((w) => w.ticket === launchTicket))) && (
          <pre className="row-error">{rowError.launch || rowError[launchTicket!]}</pre>
        )}
        {launchJob && launchJob.action === "launch" && (
          <div className="output tall">
            <div className="output-head">
              <span>
                {launchBusy && <span className="spinner" />} launch-worktree {launchJob.ticket}
                {launchJob.status === "ok" && " — done"}
                {launchJob.status === "failed" && ` — failed (exit ${launchJob.exitCode})`}
                {launchJob.status === "lost" && " — stopped without an exit code"}
              </span>
              {!launchBusy && (
                <button
                  className="link"
                  onClick={() => {
                    dismissJob(launchJob.ticket);
                    setLaunchTicket(null);
                  }}
                >
                  hide
                </button>
              )}
            </div>
            <pre ref={scrollToEnd}>{launchJob.text || "…"}</pre>
          </div>
        )}
      </section>

      {logs && (
        <div className="modal-bg" onClick={() => setLogs(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                #{logs.ticket} {logs.which} log <span className="muted small">last 200 lines</span>
              </h3>
              <div>
                <button onClick={() => showLogs(logs.ticket, logs.which)} disabled={logs.loading}>
                  ↻
                </button>
                <button onClick={() => setLogs(null)}>Close</button>
              </div>
            </div>
            {logs.loading && (
              <p className="muted">
                <span className="spinner" /> Loading…
              </p>
            )}
            {logs.error && <pre className="row-error">{logs.error}</pre>}
            {!logs.loading && !logs.error && (
              <pre className="log" ref={scrollToEnd}>
                {logs.text || "(empty)"}
              </pre>
            )}
          </div>
        </div>
      )}

      {removeDlg && <RemoveModal d={removeDlg} set={setRemoveDlg} onConfirm={confirmRemove} />}
    </main>
  );
}

function RemoveModal({
  d,
  set,
  onConfirm,
}: {
  d: RemoveDialog;
  set: (f: (d: RemoveDialog | null) => RemoveDialog | null) => void;
  onConfirm: (d: RemoveDialog) => void;
}) {
  const force = d.stage === "force";
  const repos = d.fresh?.repos ?? [];
  const dirtyRepos = repos.filter((r) => r.dirty).map((r) => r.name);
  const branch = d.fresh?.branch ?? `mithilesh/${d.ticket}`;
  const canConfirm = !d.checking && (!force || d.typed.trim() === d.ticket);
  const close = () => set(() => null);

  return (
    <div className="modal-bg" onClick={close}>
      <div className={`modal ${force ? "force" : ""}`} onClick={(e) => e.stopPropagation()}>
        <h3>{force ? `Force remove #${d.ticket}?` : `Remove #${d.ticket}?`}</h3>

        {force && (
          <div className="warn-box">
            <strong>remove-worktree refused:</strong> these repos have uncommitted changes. Force remove deletes
            them for good.
            {d.checking ? (
              <p>
                <span className="spinner" /> checking…
              </p>
            ) : (
              <ul>
                {(dirtyRepos.length ? dirtyRepos : ["(none found now — the check may have changed)"]).map((r) => (
                  <li key={r}>
                    <code>{r}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p>This permanently destroys:</p>
        <ul className="destroy">
          <li>
            the three git worktrees{" "}
            {repos.length > 0 && <span className="muted">({repos.map((r) => r.name).join(", ")})</span>}
          </li>
          <li>
            the backend containers of <code>grubbs-{d.ticket}</code> <strong>and its database volume</strong>{" "}
            <span className="muted">(docker compose down -v)</span>
          </li>
          <li>
            the folder <code>grubbs-{d.ticket}</code> (logs, ports, compose override)
          </li>
          <li>
            the T3 Code project <code>grubbs-{d.ticket}</code> and all its chats
          </li>
        </ul>

        {!force && d.checking && (
          <p className="muted">
            <span className="spinner" /> checking for uncommitted changes…
          </p>
        )}
        {!force && !d.checking && dirtyRepos.length > 0 && (
          <p className="warn-text">
            Uncommitted changes in {dirtyRepos.join(", ")}. remove-worktree will refuse; you can then choose Force
            remove.
          </p>
        )}
        {d.error && <pre className="row-error">{d.error}</pre>}

        <label className="check">
          <input
            type="checkbox"
            checked={d.deleteBranches}
            onChange={(e) => set((x) => (x ? { ...x, deleteBranches: e.target.checked } : x))}
          />
          Also delete branch <code>{branch}</code>{" "}
          <span className="muted">
            {force ? "(even when not merged)" : "(only where merged; unmerged branches are kept)"}
          </span>
        </label>

        {force && (
          <label className="typed">
            Type <code>{d.ticket}</code> to confirm
            <input
              autoFocus
              value={d.typed}
              onChange={(e) => set((x) => (x ? { ...x, typed: e.target.value } : x))}
              inputMode="numeric"
            />
          </label>
        )}

        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className={force ? "danger solid" : "danger"} disabled={!canConfirm} onClick={() => onConfirm(d)}>
            {force ? "Force remove" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
