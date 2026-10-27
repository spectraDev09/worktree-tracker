"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Action, Capabilities, JobState, RevealApp, WorktreeView } from "@/lib/types";
import { ACTION_LABEL, type Svc, ago, api, envBlock, hostOf, isRunning, lastLine, psqlUrl, services, useNow } from "./client";
import * as I from "./icons";

export type LogTab = "frontend" | "backend" | "launch";

export type CardHandlers = {
  toggle: () => void;
  act: (a: Action) => void;
  relaunch: () => void;
  open: () => void;
  reveal: (app: RevealApp) => void;
  copy: (text: string, label: string) => void;
  receipt: () => void;
  remove: () => void;
  logs: (tab: LogTab | null) => void;
};

type Props = {
  w: WorktreeView;
  index: number;
  docker: boolean | null;
  job?: JobState;
  expanded: boolean;
  dirtyRepos: string[];
  gitCheckedAt: number | null;
  error?: string;
  caps: Capabilities | null;
  logsTab: LogTab | null;
  h: CardHandlers;
};

const SVC_WORD: Record<Svc, string> = { live: "live", starting: "starting", stopped: "stopped", unknown: "unknown", busy: "working" };

export function Dot({ s }: { s: Svc }) {
  if (s === "live") return <span className="live" />;
  if (s === "starting" || s === "busy") return <span className="spin" />;
  return <span className={s === "unknown" ? "off unknown" : "off"} />;
}

export function Card(p: Props) {
  return p.expanded ? <Expanded {...p} /> : <Compact {...p} />;
}

function Compact({ w, index, docker, job, dirtyRepos, h }: Props) {
  const svc = services(w, docker, job);
  const busy = job?.status === "running";
  const parked = !isRunning(w) && !busy;
  return (
    <div
      className={`mini${parked ? " parked" : ""}${busy ? " busy" : ""}`}
      role="button"
      tabIndex={0}
      onClick={h.toggle}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && h.toggle()}
    >
      <div className="tk mono">
        <span>#</span>
        {w.ticket}
      </div>
      <div className="br mono">
        <span className="ellip">{w.branch}</span>
        {dirtyRepos.length > 0 && <span className="warnpill">● uncommitted</span>}
        {parked && <span className="faint">· parked</span>}
      </div>
      <div className="ports mono">
        <PortChip kind="app" port={w.fePort} s={svc.app} />
        <PortChip kind="api" port={w.webPort} s={svc.api} />
        <PortChip kind="db" port={w.pgPort} s={svc.db} />
      </div>
      <div className="mini-act" onClick={(e) => e.stopPropagation()}>
        {busy ? (
          <span className="booting mono">
            <span className="spin" /> {ACTION_LABEL[job!.action].toLowerCase()}…
          </span>
        ) : svc.app === "live" ? (
          <button className="openbtn" onClick={h.open}>
            Open <I.Arrow size={11} />
          </button>
        ) : (
          <button className="startbtn" onClick={() => h.act("start")} disabled={docker === false}>
            <I.Play size={10} /> Start
          </button>
        )}
      </div>
      {index < 9 && <kbd className="idx">{index + 1}</kbd>}
    </div>
  );
}

function PortChip({ kind, port, s }: { kind: "app" | "api" | "db"; port: number | null; s: Svc }) {
  return (
    <span className={`pchip ${kind} s-${s}`} title={`${kind} :${port} ${SVC_WORD[s]}`}>
      <Dot s={s} />:{port ?? "—"}
    </span>
  );
}

function Expanded({ w, docker, job, dirtyRepos, gitCheckedAt, error, caps, logsTab, h }: Props) {
  const now = useNow(15_000);
  const svc = services(w, docker, job);
  const busy = job?.status === "running";
  const anyUp = isRunning(w);
  const allUp = svc.app === "live" && svc.api === "live";
  const launch = w.lastLaunch;
  const noDocker = docker === false;

  return (
    <article className={`card${busy ? " busy" : ""}${anyUp || busy ? "" : " parked"}`}>
      <div className="head">
        <button className="ticket mono" onClick={h.toggle} title="Collapse">
          <span>#</span>
          {w.ticket}
        </button>
        <span className="branch mono">{w.branch}</span>
        {dirtyRepos.length > 0 && <span className="warnpill">● uncommitted</span>}
        {busy && (
          <span className="busy-label mono">
            <span className="spin" /> {ACTION_LABEL[job!.action]}…
          </span>
        )}
        <div className="head-right">
          {launch?.finishedAt && launch.status === "ok" && (
            <span className="dim">
              launched <b>{ago(now - launch.finishedAt)}</b> ago
            </span>
          )}
          <HealthRing svc={svc} />
        </div>
      </div>

      <div className="sockets">
        <Socket
          kind="app"
          label="APP"
          sub="next dev"
          s={svc.app}
          port={w.fePort}
          host={hostOf(w.feUrl)}
          tools={
            svc.app === "live" ? (
              <>
                <Tool title="Restart frontend" onClick={() => h.act("restart-frontend")} icon={<I.Restart />} />
                <Tool title="Stop frontend" onClick={() => h.act("stop-frontend")} icon={<I.Stop size={11} />} />
              </>
            ) : svc.app === "stopped" ? (
              <Tool title="Start frontend" onClick={() => h.act("restart-frontend")} icon={<I.Play size={11} />} />
            ) : null
          }
        >
          <button className="chip primary" onClick={h.open} disabled={svc.app !== "live"}>
            Open <I.Arrow size={11} />
          </button>
          <CopyChip text={w.feUrl ?? ""} label="app URL" copy={h.copy} />
          <button className="chip" onClick={() => h.logs(logsTab === "frontend" ? null : "frontend")}>
            <I.Logs size={11} /> logs
          </button>
        </Socket>

        <Socket
          kind="api"
          label="API"
          sub={noDocker ? "docker off" : `docker ${w.containersRunning}/3`}
          s={svc.api}
          port={w.webPort}
          host={hostOf(w.apiUrl)}
          tools={
            svc.api === "live" || svc.api === "starting" ? (
              <>
                <Tool title="Restart backend" onClick={() => h.act("restart-backend")} icon={<I.Restart />} />
                <Tool title="Stop backend (Postgres too)" onClick={() => h.act("stop-backend")} icon={<I.Stop size={11} />} />
              </>
            ) : svc.api === "stopped" ? (
              <Tool title="Start backend" onClick={() => h.act("restart-backend")} icon={<I.Play size={11} />} />
            ) : null
          }
        >
          <CopyChip text={w.apiUrl ?? ""} label="API URL" copy={h.copy} />
          <button className="chip" onClick={() => h.logs(logsTab === "backend" ? null : "backend")} disabled={noDocker}>
            <I.Logs size={11} /> logs
          </button>
        </Socket>

        <Socket kind="db" label="DB" sub="postgres" s={svc.db} port={w.pgPort} host="admin / admin · grubbs_db">
          <CopyChip text={psqlUrl(w)} label="Postgres URL" copy={h.copy} caption="url" />
          <CopyChip text={`psql '${psqlUrl(w)}'`} label="psql command" copy={h.copy} caption="psql" />
        </Socket>
      </div>

      {launch?.status === "ok" &&
        launch.warnings.map((why) => (
          <div className="warnbar" key={why}>
            <I.Warn size={14} />
            <span>
              {why} on the last launch. The worktree is fine.
            </span>
            {/T3/.test(why) && caps?.t3 && (
              <button className="btn" onClick={() => h.reveal("t3")}>
                <I.T3 /> Open in T3 Code
              </button>
            )}
          </div>
        ))}
      {launch && launch.status !== "ok" && launch.status !== "running" && !busy && (
        <div className="warnbar bad">
          <I.Warn size={14} />
          <span>Last launch failed: {launch.error ?? `exit ${launch.exitCode}`}</span>
          <button className="btn" onClick={h.relaunch}>
            <I.Restart /> Launch again
          </button>
        </div>
      )}

      {busy && job!.action !== "launch" && <div className="activity mono">{lastLine(job!.text) || "…"}</div>}
      {error && <pre className="row-error">{error}</pre>}

      <div className="meta">
        {w.repos.map((r) => (
          <span key={r.name} className={`repo mono${dirtyRepos.includes(r.name) ? " dirty" : ""}`} title={r.branch ?? ""}>
            <i />
            {r.name}
          </span>
        ))}
        <span className="spacer" />
        {gitCheckedAt && <span className="faint">git checked {ago(now - gitCheckedAt)} ago</span>}
      </div>

      <div className="actions">
        {caps?.t3 && (
          <button className="btn t3" onClick={() => h.reveal("t3")} title="Open this worktree in T3 Code">
            <I.T3 /> T3 Code
          </button>
        )}
        {caps?.terminal && (
          <button className="btn" onClick={() => h.reveal("terminal")} title={`${caps.terminal} in this worktree`}>
            <I.Term /> Terminal
          </button>
        )}
        {caps?.editor && (
          <button className="btn" onClick={() => h.reveal("editor")} title={`Open in ${caps.editor}`}>
            <I.Code /> {caps.editor === "Visual Studio Code" ? "VS Code" : caps.editor}
          </button>
        )}
        <button className="btn" onClick={() => h.reveal("finder")}>
          <I.Folder /> Finder
        </button>
        <span className="spacer" />
        <button className={`btn ghost${logsTab ? " on" : ""}`} onClick={() => h.logs(logsTab ? null : "frontend")}>
          <I.Logs /> Logs
        </button>
        <button className="btn ghost" onClick={h.receipt}>
          <I.Ticket /> Receipt
        </button>
        {anyUp && (
          <button className="btn ghost" onClick={() => h.act("stop")} disabled={busy || noDocker} title="Stop the frontend and the backend stack. Ports and data stay.">
            <I.Stop size={11} /> Stop
          </button>
        )}
        {!allUp && (
          <button className="btn go" onClick={() => h.act("start")} disabled={busy || noDocker}>
            <I.Play size={11} /> Start
          </button>
        )}
        <Menu
          items={[
            { label: "Copy .env block", icon: <I.Copy />, run: () => h.copy(envBlock(w), ".env block") },
            { label: "Copy folder path", icon: <I.Folder />, run: () => h.copy(w.path ?? "", "folder path") },
            { label: "Launch again (repair)", icon: <I.Restart />, run: h.relaunch, disabled: busy },
            { label: "Remove…", icon: <I.Trash />, run: h.remove, danger: true, disabled: busy || noDocker },
          ]}
        />
      </div>

      {logsTab && <LogPanel ticket={w.ticket} launchId={launch?.id ?? null} docker={docker} tab={logsTab} setTab={h.logs} />}
    </article>
  );
}

function Socket({
  kind,
  label,
  sub,
  s,
  port,
  host,
  tools,
  children,
}: {
  kind: "app" | "api" | "db";
  label: string;
  sub: string;
  s: Svc;
  port: number | null;
  host: string;
  tools?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`sock ${kind} s-${s}`}>
      <div className="lbl">
        <Dot s={s} />
        <span className="lbl-t">
          {label} · {sub.toUpperCase()}
        </span>
        <span className="tools">{tools}</span>
      </div>
      <div className="port mono">
        <span>
          <span className="colon">:</span>
          {port ?? "—"}
        </span>
        <span className={`st s-${s}`}>{SVC_WORD[s]}</span>
      </div>
      <div className="host mono">{host}</div>
      <div className="row">{children}</div>
      <Beat kind={kind} s={s} />
    </div>
  );
}

function Tool({ title, onClick, icon }: { title: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button className="ico" title={title} aria-label={title} onClick={onClick}>
      {icon}
    </button>
  );
}

export function CopyChip({
  text,
  label,
  copy,
  caption = "copy",
  className = "chip mono",
}: {
  text: string;
  label: string;
  copy: (text: string, label: string) => void;
  caption?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      className={`${className}${done ? " copied" : ""}`}
      title={`Copy ${label}: ${text}`}
      disabled={!text}
      onClick={() => {
        copy(text, label);
        setDone(true);
      }}
    >
      {done ? <I.Check size={11} /> : <I.Copy size={11} />} {done ? "copied" : caption}
    </button>
  );
}

// A heartbeat that scrolls while the service answers, a flat line when it does not.
function Beat({ kind, s }: { kind: string; s: Svc }) {
  const flat = s === "stopped" || s === "unknown";
  return (
    <svg className={`beat ${flat ? "flat" : `s-${s}`}`} viewBox="0 0 200 22" preserveAspectRatio="none" aria-hidden="true">
      {flat ? (
        <path d="M0 15H200" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 5" />
      ) : (
        <g className={`scan ${kind}`}>
          <path
            d="M0 15H30l4-9 5 14 4-8 3 3H95l4-9 5 14 4-8 3 3H160l3-6 4 9 3-3h30M200 15h30l4-9 5 14 4-8 3 3h53l4-9 5 14 4-8 3 3h46l3-6 4 9 3-3h30"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </g>
      )}
    </svg>
  );
}

// Three arcs, one per service, lit in the service's colour when it answers.
function HealthRing({ svc }: { svc: Record<"app" | "api" | "db", Svc> }) {
  const order = ["app", "api", "db"] as const;
  const up = order.filter((k) => svc[k] === "live").length;
  const C = 2 * Math.PI * 14;
  const seg = C / 3 - 3.5;
  return (
    <svg className="ring" width="34" height="34" viewBox="0 0 36 36" role="img" aria-label={`${up} of 3 services up`}>
      <circle cx="18" cy="18" r="14" fill="none" stroke="var(--line)" strokeWidth="4" />
      {order.map((k, i) => (
        <circle
          key={k}
          className={`arc s-${svc[k]}`}
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke={`var(--${k})`}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${seg} ${C - seg}`}
          strokeDashoffset={-(i * C) / 3}
          transform="rotate(-90 18 18)"
        />
      ))}
      <text x="18" y="21.5" textAnchor="middle">
        {up}/3
      </text>
    </svg>
  );
}

type MenuItem = { label: string; icon: React.ReactNode; run: () => void; danger?: boolean; disabled?: boolean };

function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn ghost" aria-label="More" title="More" onClick={() => setOpen((o) => !o)}>
        <I.More />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={it.danger ? "danger" : undefined}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
            >
              {it.icon} {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Logs: an inline terminal that re-reads the tail every 2s while it is open and following.

function lineClass(l: string): string | undefined {
  if (/(^|\s)(error|Error|ERROR|Traceback|FATAL|Exception)\b|⨯|✗/.test(l)) return "e";
  if (/⚠|\bwarn(ing)?\b|WARN/i.test(l)) return "w";
  if (/✓|\bReady\b|Compiled|Started|answering|200 in/.test(l)) return "ok";
  if (/^(\S+\s+)?(GET|POST|PUT|PATCH|DELETE)\b|"(GET|POST|PUT|PATCH|DELETE) /.test(l)) return "req";
  if (/^==> /.test(l)) return "say";
  return undefined;
}

function LogPanel({
  ticket,
  launchId,
  docker,
  tab,
  setTab,
}: {
  ticket: string;
  launchId: string | null;
  docker: boolean | null;
  tab: LogTab;
  setTab: (t: LogTab) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setText(null);
    setError(null);
  }, [tab, ticket]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const t =
          tab === "launch"
            ? (await api<JobState>(`/api/jobs/${launchId}`)).text
            : (await api<{ text: string }>(`/api/worktrees/${ticket}/logs?which=${tab}&lines=400`)).text;
        if (alive) {
          setText(t);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive && follow && tab !== "launch") timer = setTimeout(load, document.hidden ? 15_000 : 2_000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tab, follow, ticket, launchId]);

  useLayoutEffect(() => {
    if (follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, follow]);

  // The page's own "is the API answering" probe, every few seconds per open window.
  const all = (text ?? "").trimEnd().split("\n");
  const lines = tab === "backend" ? all.filter((l) => !l.includes("worktrees-probe")) : all;
  const hidden = all.length - lines.length;
  return (
    <div className="term">
      <div className="tabs mono">
        {(
          [
            ["frontend", "app", "var(--app)"],
            ["backend", "api", "var(--api)"],
            ["launch", "launch log", "var(--dim)"],
          ] as const
        ).map(([k, label, color]) => (
          <button
            key={k}
            className={`tab${tab === k ? " on" : ""}`}
            onClick={() => setTab(k)}
            disabled={(k === "launch" && !launchId) || (k === "backend" && docker === false)}
          >
            <span className="sw" style={{ background: color }} />
            {label}
          </button>
        ))}
        {hidden > 0 && <span className="hidden-note">{hidden} probe lines hidden</span>}
        {tab !== "launch" && (
          <button className={`follow${follow ? " on" : ""}`} onClick={() => setFollow((f) => !f)} title="Re-read every 2s">
            {follow ? <span className="live" /> : <span className="off" />}
            {follow ? "following" : "paused"}
          </button>
        )}
      </div>
      {error ? (
        <pre className="lines row-error">{error}</pre>
      ) : text === null ? (
        <div className="lines muted">
          <span className="spin" /> reading…
        </div>
      ) : (
        <pre
          className="lines"
          ref={pre}
          onWheel={(e) => {
            if (e.deltaY < 0 && follow) setFollow(false);
          }}
        >
          {lines.join("").trim() === ""
            ? "(empty)"
            : lines.map((l, i) => (
                <span key={i} className={lineClass(l)}>
                  {l}
                  {"\n"}
                </span>
              ))}
        </pre>
      )}
    </div>
  );
}
