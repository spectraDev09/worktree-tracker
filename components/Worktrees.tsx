"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseLaunch } from "@/lib/stages";
import type { Action, Capabilities, JobState, ListResponse, RevealApp, WorktreeView } from "@/lib/types";
import { Card, type CardHandlers, type LogTab } from "./Card";
import { ACTION_DONE, ACTION_LABEL, api, isRunning, post, tail } from "./client";
import * as I from "./icons";
import { LaunchPanel, Receipt } from "./Launch";
import { DEFAULT_OPTS, type LaunchOpts, Launcher } from "./Launcher";
import { type RemoveDialog, RemoveModal } from "./RemoveModal";

const FAST_VISIBLE_MS = 5_000;
const FAST_HIDDEN_MS = 30_000;
const GIT_MS = 60_000;
const JOB_POLL_MS = 1_000;
const FRESH_RECEIPT_MS = 12 * 3600_000; // a launch that finished while the window was closed waits this long

type Toast = { id: number; text: string; tone?: "ok" | "bad" };

const optsFromArgs = (args: string[]): LaunchOpts => {
  const after = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? (args[i + 1] ?? "") : "";
  };
  return {
    ...DEFAULT_OPTS,
    backendBase: after("--backend-base"),
    frontendBase: after("--frontend-base"),
    start: !args.includes("--no-start"),
    refreshSnapshot: false, // a retry or repair should not force another rebuild of many minutes
    openWhenUp: false,
  };
};

function seenReceipts(): string[] {
  try {
    return JSON.parse(localStorage.getItem("gw.seenReceipts") ?? "[]");
  } catch {
    return [];
  }
}

function markReceiptsSeen(ids: string[]) {
  const seen = [...ids, ...seenReceipts().filter((x) => !ids.includes(x))];
  localStorage.setItem("gw.seenReceipts", JSON.stringify(seen.slice(0, 50)));
}

function notify(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) return;
  new Notification(title, { body, icon: "/icon-192.png", tag: title });
}

export default function Worktrees() {
  const [list, setList] = useState<WorktreeView[] | null>(null);
  const [docker, setDocker] = useState<boolean | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [gitCheckedAt, setGitCheckedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dirty, setDirty] = useState<Record<string, string[]>>({});
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const [removeDlg, setRemoveDlg] = useState<RemoveDialog | null>(null);
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined); // undefined: not chosen yet
  const [logsTab, setLogsTab] = useState<LogTab | null>(null);
  const [palette, setPalette] = useState(false);
  const [panel, setPanel] = useState<string | null>(null); // the ticket whose launch the top panel shows
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [dockerStarting, setDockerStarting] = useState(false);

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const removeOptsRef = useRef<Record<string, boolean>>({}); // ticket -> deleteBranches, for the Force step
  const finishedRef = useRef(new Set<string>()); // job ids already reported, which a late list must not revive
  const openWhenUpRef = useRef(new Set<string>());

  const say = useCallback((text: string, tone?: Toast["tone"]) => setToast({ id: Date.now(), text, tone }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((x) => (x?.id === toast.id ? null : x)), toast.tone === "bad" ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);

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
      if (r.docker) setDockerStarting(false);
      if (r.git) {
        setGitCheckedAt(r.checkedAt);
        setDirty(
          Object.fromEntries(r.worktrees.map((w) => [w.ticket, w.repos.filter((x) => x.dirty).map((x) => x.name)])),
        );
      }
      setExpanded((e) => {
        if (e !== undefined) return e;
        const saved = localStorage.getItem("gw.expanded");
        return r.worktrees.some((w) => w.ticket === saved) ? saved : (r.worktrees[0]?.ticket ?? null);
      });
      // Jobs started before a reload, or from another window, still show their progress.
      const known = jobsRef.current;
      const adopt = r.jobs.filter((j) => known[j.ticket]?.id !== j.id && !finishedRef.current.has(j.id));
      if (adopt.length) {
        setJobs((prev) => {
          const next = { ...prev };
          for (const j of adopt) next[j.ticket] = { ...j, text: "", offset: 0 };
          return next;
        });
      }
      const launch = adopt.find((j) => j.action === "launch");
      if (launch && !panelRef.current) {
        panelRef.current = launch.ticket;
        setPanel(launch.ticket);
      }
      // A launch that finished while the window was closed: the newest one's receipt is waiting.
      if (!panelRef.current) {
        const seen = new Set(seenReceipts());
        const fresh = r.worktrees
          .filter(
            (w) =>
              w.lastLaunch?.status === "ok" &&
              w.lastLaunch.finishedAt &&
              Date.now() - w.lastLaunch.finishedAt < FRESH_RECEIPT_MS &&
              !seen.has(w.lastLaunch.id),
          )
          .sort((a, b) => b.lastLaunch!.finishedAt! - a.lastLaunch!.finishedAt!)[0];
        if (fresh) setPanel(fresh.ticket);
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
      timer = setTimeout(
        async () => {
          await refresh(false);
          schedule();
        },
        document.hidden ? FAST_HIDDEN_MS : FAST_VISIBLE_MS,
      );
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
    api<Capabilities>("/api/capabilities")
      .then(setCaps)
      .catch(() => {});
    return () => {
      clearTimeout(timer);
      clearInterval(git);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (expanded) localStorage.setItem("gw.expanded", expanded);
  }, [expanded]);

  // A panel for a worktree that is gone (removed from a terminal, say) would show nothing and block others.
  useEffect(() => {
    if (panel && list && !jobs[panel] && !list.some((w) => w.ticket === panel)) setPanel(null);
  }, [panel, list, jobs]);

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

  const dropJob = useCallback(
    (ticket: string) =>
      setJobs((prev) => {
        const { [ticket]: _, ...rest } = prev;
        return rest;
      }),
    [],
  );

  const openForceDialog = useCallback(async (ticket: string) => {
    setRemoveDlg({ ticket, stage: "force", deleteBranches: removeOptsRef.current[ticket] ?? false, checking: true, typed: "" });
    try {
      const fresh = await api<WorktreeView>(`/api/worktrees/${ticket}`);
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, fresh, checking: false } : d));
    } catch (e) {
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, checking: false, error: (e as Error).message } : d));
    }
  }, []);

  const onJobDone = useCallback(
    (job: JobState) => {
      const ok = job.status === "ok";
      const t = job.ticket;
      finishedRef.current.add(job.id);
      if (job.action === "launch") {
        const v = parseLaunch(job.text, job.status, job.args.includes("--no-start"));
        if (ok) {
          setCelebrate(t);
          setPanel((p) => p ?? t);
          const p = v.ports;
          notify(
            v.finished === "ready" ? `grubbs-${t} is ready` : `grubbs-${t} is up`,
            p ? `app :${p.fe} · api :${p.web} · db :${p.pg}` : "",
          );
          if (openWhenUpRef.current.delete(t) && v.finished === "up") post(`/api/worktrees/${t}/open`).catch(() => {});
        } else {
          openWhenUpRef.current.delete(t);
          notify(`Launch of #${t} failed`, v.stages.find((s) => s.state === "failed")?.warning ?? "");
          setPanel((p) => p ?? t);
        }
      } else if (job.action === "remove" && ok) {
        say(`grubbs-${t} removed`, "ok");
        dropJob(t);
        setExpanded((e) => (e === t ? null : e));
        setPanel((p) => (p === t ? null : p));
        setReceiptFor((r) => (r === t ? null : r));
      } else if (job.action === "remove" && job.refusedDirty) {
        dropJob(t);
        setRowError((e) => ({ ...e, [t]: "Refused: uncommitted changes. Force remove is offered." }));
        openForceDialog(t);
      } else if (ok) {
        say(`#${t} ${ACTION_DONE[job.action]}`, "ok");
        dropJob(t);
      } else {
        const why = job.status === "lost" ? "the command stopped without an exit code" : `exit ${job.exitCode}`;
        setRowError((e) => ({ ...e, [t]: `${ACTION_LABEL[job.action]} failed (${why}):\n${tail(job.text)}` }));
        dropJob(t);
      }
      refresh(true);
    },
    [refresh, openForceDialog, dropJob, say],
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

  const track = useCallback((meta: JobState) => {
    const job: JobState = { ...meta, status: "running", exitCode: null, finishedAt: null, text: "", offset: 0, refusedDirty: false };
    jobsRef.current = { ...jobsRef.current, [meta.ticket]: job };
    setJobs((prev) => ({ ...prev, [meta.ticket]: job }));
  }, []);

  const clearError = (ticket: string) =>
    setRowError((e) => {
      const { [ticket]: _, ...rest } = e;
      return rest;
    });

  const act = useCallback(
    async (ticket: string, action: Exclude<Action, "launch">, extra: Record<string, unknown> = {}) => {
      clearError(ticket);
      try {
        track(await post<JobState>(`/api/worktrees/${ticket}/actions`, { action, ...extra }));
      } catch (e) {
        setRowError((err) => ({ ...err, [ticket]: (e as Error).message }));
      }
    },
    [track],
  );

  const launch = useCallback(
    async (ticket: string, o: LaunchOpts) => {
      clearError(ticket);
      if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
      try {
        const meta = await post<JobState>("/api/launch", {
          ticket,
          backendBase: o.backendBase.trim() || undefined,
          frontendBase: o.frontendBase.trim() || undefined,
          noStart: !o.start,
          refreshSnapshot: o.refreshSnapshot,
        });
        track(meta);
        if (o.openWhenUp && o.start) openWhenUpRef.current.add(ticket);
        setCelebrate(null);
        setPanel(ticket);
        setExpanded(ticket);
        setPalette(false);
      } catch (e) {
        say(`Could not launch #${ticket}: ${(e as Error).message}`, "bad");
      }
    },
    [track, say],
  );

  // Closing one receipt acknowledges every finished launch, so old ones do not queue up behind it.
  const closePanel = () => {
    if (!panel) return;
    const job = jobs[panel];
    markReceiptsSeen([
      ...(job?.status === "ok" ? [job.id] : []),
      ...(list ?? []).flatMap((w) => (w.lastLaunch?.status === "ok" ? [w.lastLaunch.id] : [])),
    ]);
    if (job && job.status !== "running") dropJob(panel);
    setPanel(null);
    setCelebrate(null);
  };

  // ---------------------------------------------------------------------------------------------
  // Row actions

  const open = useCallback(
    async (ticket: string) => {
      try {
        await post(`/api/worktrees/${ticket}/open`);
      } catch (e) {
        say((e as Error).message, "bad");
      }
    },
    [say],
  );

  const reveal = useCallback(
    async (ticket: string, app: RevealApp) => {
      try {
        await post(`/api/worktrees/${ticket}/reveal`, { app });
        say(app === "t3" ? `Opening grubbs-${ticket} in T3 Code` : `Opened grubbs-${ticket}`, "ok");
      } catch (e) {
        say((e as Error).message, "bad");
      }
    },
    [say],
  );

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        say(`Copied ${label}${text.includes("\n") ? "" : `: ${text}`}`);
      } catch {
        say("The clipboard is not available here", "bad");
      }
    },
    [say],
  );

  const askRemove = async (ticket: string) => {
    setRemoveDlg({ ticket, stage: "confirm", deleteBranches: false, checking: true, typed: "" });
    try {
      const fresh = await api<WorktreeView>(`/api/worktrees/${ticket}`);
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, fresh, checking: false } : d));
    } catch (e) {
      setRemoveDlg((d) => (d && d.ticket === ticket ? { ...d, checking: false, error: (e as Error).message } : d));
    }
  };

  const confirmRemove = (d: RemoveDialog) => {
    removeOptsRef.current[d.ticket] = d.deleteBranches;
    setRemoveDlg(null);
    act(d.ticket, "remove", { force: d.stage === "force", deleteBranches: d.deleteBranches });
  };

  const jump = useCallback((ticket: string) => {
    setPalette(false);
    setExpanded(ticket);
    setFlash(ticket);
    setTimeout(() => setFlash((f) => (f === ticket ? null : f)), 1300);
    requestAnimationFrame(() => document.getElementById(`wt-${ticket}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, []);

  const handlers = (w: WorktreeView): CardHandlers => ({
    toggle: () => setExpanded((e) => (e === w.ticket ? null : w.ticket)),
    act: (a) => (a === "launch" ? launch(w.ticket, DEFAULT_OPTS) : act(w.ticket, a)),
    relaunch: () => launch(w.ticket, { ...optsFromArgs(w.lastLaunch?.args ?? []), start: true }),
    open: () => open(w.ticket),
    reveal: (app) => reveal(w.ticket, app),
    copy,
    receipt: () => setReceiptFor(w.ticket),
    remove: () => askRemove(w.ticket),
    logs: setLogsTab,
  });

  // ---------------------------------------------------------------------------------------------
  // Keyboard: ⌘K launches or finds; 1–9 pick a worktree; o / l / t / c act on the open one.

  const keyState = useRef({ list, expanded, modal: false });
  keyState.current = { list, expanded, modal: palette || !!removeDlg || !!receiptFor };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      const { list, expanded, modal } = keyState.current;
      if (e.key === "Escape") {
        setReceiptFor(null);
        return;
      }
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
      if (typing || modal || e.metaKey || e.ctrlKey || e.altKey) return;
      const w = list?.find((x) => x.ticket === expanded);
      if (e.key === "/" || e.key === "n") {
        e.preventDefault();
        setPalette(true);
      } else if (/^[1-9]$/.test(e.key) && list?.[+e.key - 1]) {
        jump(list[+e.key - 1].ticket);
      } else if (w && e.key === "o") open(w.ticket);
      else if (w && e.key === "l") setLogsTab((t) => (t ? null : "frontend"));
      else if (w && e.key === "t") reveal(w.ticket, "t3");
      else if (w && e.key === "c" && w.feUrl) copy(w.feUrl, "app URL");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump, open, reveal, copy]);

  // ---------------------------------------------------------------------------------------------
  // Render

  const live = list?.filter(isRunning).length ?? 0;
  const bound =
    list?.reduce((n, w) => n + (w.frontendUp ? 1 : 0) + (docker !== false && w.containersRunning > 0 ? 2 : 0), 0) ?? 0;
  const busyTickets = new Set(Object.values(jobs).filter((j) => j.status === "running").map((j) => j.ticket));
  const panelW = panel ? list?.find((w) => w.ticket === panel) : undefined;
  const receiptW = receiptFor ? list?.find((w) => w.ticket === receiptFor) : undefined;
  const receiptHandlers = (ticket: string) => ({
    open: () => open(ticket),
    reveal: (app: RevealApp) => reveal(ticket, app),
    copy,
  });

  return (
    <main>
      <header className="top">
        <div className="brand">
          <I.Logo />
          worktrees <small>grubbs</small>
        </div>
        {list && (
          <>
            <span className="pill" title="Worktrees with anything running">
              {live ? <span className="live" style={{ color: "var(--app)" }} /> : <span className="off" />}
              <b>{live}</b> live
            </span>
            <span className="pill mono bound" title="Ports with a frontend, API or Postgres behind them">
              <b>{bound}</b> ports bound
            </span>
          </>
        )}
        <span
          className={`pill docker ${docker === false ? "down" : docker ? "up" : ""}`}
          title={docker === false ? "Docker is not running" : "Docker is running"}
        >
          <I.Whale /> docker
        </span>
        <button
          className="iconbtn"
          onClick={() => refresh(true)}
          disabled={refreshing}
          title={checkedAt ? `Checked ${new Date(checkedAt).toLocaleTimeString()}. Refresh, with git` : "Refresh"}
          aria-label="Refresh"
        >
          {refreshing ? <span className="spin" /> : <I.Refresh />}
        </button>
        <button className="launch-btn" onClick={() => setPalette(true)}>
          <I.Plus size={14} /> Launch ticket <kbd>⌘K</kbd>
        </button>
      </header>

      {docker === false && (
        <div className="banner">
          <I.Whale size={16} />
          <span>
            <b>Docker is not running.</b> Backends are unknown, and backend actions are off until it is up.
          </span>
          <button
            className="btn"
            disabled={dockerStarting}
            onClick={() => {
              setDockerStarting(true);
              post("/api/docker").catch((e) => {
                setDockerStarting(false);
                say((e as Error).message, "bad");
              });
            }}
          >
            {dockerStarting ? (
              <>
                <span className="spin" /> starting…
              </>
            ) : (
              "Start Docker"
            )}
          </button>
        </div>
      )}
      {listError && <div className="banner error">Could not list worktrees: {listError}</div>}

      {panel && (
        <LaunchPanel
          ticket={panel}
          job={jobs[panel]?.action === "launch" ? jobs[panel] : undefined}
          w={panelW}
          caps={caps}
          celebrate={celebrate === panel}
          h={receiptHandlers(panel)}
          onClose={closePanel}
          onRetry={() => {
            const j = jobs[panel];
            launch(panel, j ? optsFromArgs(j.args) : DEFAULT_OPTS);
          }}
        />
      )}

      {list === null && !listError && (
        <div className="loading">
          <span className="spin" /> Reading worktrees…
        </div>
      )}

      {list?.length === 0 && (
        <div className="empty">
          <svg width="120" height="110" viewBox="0 0 120 110" aria-hidden="true">
            <ellipse cx="60" cy="100" rx="40" ry="5" fill="#121b24" />
            <path className="sprout" d="M60 100V58" stroke="#5b6b7d" strokeWidth="5" strokeLinecap="round" fill="none" />
            <ellipse className="sprout-leaf l" cx="46" cy="60" rx="14" ry="7" fill="#2f6b3d" transform="rotate(-30 46 60)" />
            <ellipse className="sprout-leaf r" cx="74" cy="52" rx="14" ry="7" fill="#3e8a4f" transform="rotate(30 74 52)" />
            <circle cx="60" cy="40" r="7" fill="var(--app)" className="bud" />
          </svg>
          <p>No worktrees yet.</p>
          <button className="launch-btn" onClick={() => setPalette(true)}>
            <I.Plus size={14} /> Launch your first ticket <kbd>⌘K</kbd>
          </button>
        </div>
      )}

      <div className="list">
        {list?.map((w, i) => (
          <div key={w.ticket} id={`wt-${w.ticket}`} className={flash === w.ticket ? "flash" : undefined}>
            <Card
              w={w}
              index={i}
              docker={docker}
              job={jobs[w.ticket]}
              expanded={expanded === w.ticket}
              dirtyRepos={dirty[w.ticket] ?? []}
              gitCheckedAt={gitCheckedAt}
              error={rowError[w.ticket]}
              caps={caps}
              logsTab={logsTab}
              h={handlers(w)}
            />
          </div>
        ))}
      </div>

      {list && list.length > 0 && (
        <footer className="foot mono">
          <span>
            <kbd>⌘K</kbd> launch / find
          </span>
          <span>
            <kbd>1</kbd>–<kbd>9</kbd> pick
          </span>
          <span>
            <kbd>o</kbd> open app
          </span>
          <span>
            <kbd>c</kbd> copy URL
          </span>
          <span>
            <kbd>l</kbd> logs
          </span>
          {caps?.t3 && (
            <span>
              <kbd>t</kbd> T3 Code
            </span>
          )}
        </footer>
      )}

      {palette && list && (
        <Launcher
          worktrees={list}
          docker={docker}
          busy={busyTickets}
          onClose={() => setPalette(false)}
          onLaunch={launch}
          onJump={jump}
        />
      )}

      {receiptW && (
        <div className="modal-bg" onMouseDown={() => setReceiptFor(null)}>
          <div className="receipt-modal" onMouseDown={(e) => e.stopPropagation()}>
            <button className="panel-x" onClick={() => setReceiptFor(null)}>
              Close
            </button>
            <Receipt w={receiptW} launch={receiptW.lastLaunch} caps={caps} confetti={false} h={receiptHandlers(receiptW.ticket)} />
          </div>
        </div>
      )}

      {removeDlg && <RemoveModal d={removeDlg} set={setRemoveDlg} onConfirm={confirmRemove} />}

      {toast && (
        <div key={toast.id} className={`toast ${toast.tone ?? ""}`} role="status">
          {toast.tone === "bad" ? <I.Warn size={13} /> : <I.Check size={13} />}
          <span>{toast.text}</span>
        </div>
      )}
    </main>
  );
}
