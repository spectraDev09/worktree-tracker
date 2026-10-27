"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type LaunchView, parseLaunch } from "@/lib/stages";
import type { Capabilities, JobState, LaunchSummary, RevealApp, WorktreeView } from "@/lib/types";
import { CopyChip } from "./Card";
import { clock, envBlock, hostOf, isRunning, psqlUrl, timeOf, useNow } from "./client";
import * as I from "./icons";

type ReceiptHandlers = {
  open: () => void;
  reveal: (app: RevealApp) => void;
  copy: (text: string, label: string) => void;
};

// ---------------------------------------------------------------------------------------------
// The panel at the top of the page for one launch: a growing tree while it runs, the receipt
// once it is up. It reads the same job log the script writes, so a reload picks it up mid-way.

export function LaunchPanel({
  ticket,
  job,
  w,
  caps,
  celebrate,
  h,
  onClose,
  onRetry,
}: {
  ticket: string;
  job?: JobState;
  w?: WorktreeView;
  caps: Capabilities | null;
  celebrate: boolean;
  h: ReceiptHandlers;
  onClose: () => void;
  onRetry: () => void;
}) {
  const ok = job ? job.status === "ok" : w?.lastLaunch?.status === "ok";
  if (ok && w) {
    return (
      <section className="launch-panel receipt-mode">
        <button className="panel-x" onClick={onClose} aria-label="Close">
          Done
        </button>
        <Receipt w={w} launch={w.lastLaunch} job={job} caps={caps} confetti={celebrate} h={h} />
      </section>
    );
  }
  if (!job) return null;
  return <Progress ticket={ticket} job={job} onClose={onClose} onRetry={onRetry} />;
}

function Progress({ ticket, job, onClose, onRetry }: { ticket: string; job: JobState; onClose: () => void; onRetry: () => void }) {
  const running = job.status === "running";
  const noStart = job.args.includes("--no-start");
  const v = useMemo(() => parseLaunch(job.text, job.status, noStart), [job.text, job.status, noStart]);
  const now = useNow(1000, running);
  const [raw, setRaw] = useState(false);
  const failed = !running && job.status !== "ok";
  const elapsed = (job.finishedAt ?? now) - job.startedAt;
  const shown = v.stages.filter((s) => s.state !== "skipped" || !noStart);

  return (
    <section className={`launch-panel${failed ? " failed" : ""}`}>
      {running && (
        <button className="panel-x" onClick={onClose} title="The launch keeps going; its receipt shows here when it is up">
          Hide
        </button>
      )}
      <div className="launch">
        <div className="stage">
          <span className="clock mono">{clock(Math.max(0, elapsed))}</span>
          <span className="tkt mono">
            <span className="faint">#</span>
            {ticket}
          </span>
          <Tree v={v} />
          <div className="flabels mono">
            <span className={`db${v.fruit.db ? " on" : ""}`}>db :{v.ports?.pg ?? "…"}</span>
            <span className={`api${v.fruit.api ? " on" : ""}`}>api :{v.ports?.web ?? "…"}</span>
            <span className={`app${v.fruit.app ? " on" : ""}`}>app :{v.ports?.fe ?? "…"}</span>
          </div>
        </div>
        <div className="launch-right">
          <div className="launch-title">
            {running ? (
              <>
                Launching <b className="mono">grubbs-{ticket}</b>
              </>
            ) : failed ? (
              <>
                Launch of <b className="mono">grubbs-{ticket}</b> {job.status === "lost" ? "stopped" : "failed"}
              </>
            ) : (
              <>
                <b className="mono">grubbs-{ticket}</b> {v.finished === "ready" ? "is ready, nothing started" : "is up"}
              </>
            )}
            <span className="cmd mono">{["launch-worktree", ...job.args.slice(1)].join(" ")}</span>
          </div>
          {failed && !v.stages.some((s) => s.state === "failed") && (
            <div className="launch-error mono">{v.error ?? "stopped without an exit code"}</div>
          )}
          <ul className="steps">
            {shown.map((s) => (
              <li key={s.key} className={s.state}>
                <span className="b" />
                <span className="l">{s.label}</span>
                <span className="d mono">{s.state === "skipped" ? "skipped" : s.detail}</span>
                {(s.state === "active" || s.state === "warn" || s.state === "failed") && (s.warning || s.last) && (
                  <span className="sub mono">{s.state === "active" ? s.last : s.warning}</span>
                )}
              </li>
            ))}
          </ul>
          <div className="bar">
            <i style={{ width: `${Math.round(v.progress * 100)}%` }} />
          </div>
          <div className="reassure">
            {running ? (
              <>
                <I.Shield />
                Close the window if you like. It keeps running, and the receipt waits for you.
              </>
            ) : failed ? (
              <>
                <button className="btn go" onClick={onRetry}>
                  <I.Restart /> Try again
                </button>
                <button className="btn ghost" onClick={onClose}>
                  Dismiss
                </button>
              </>
            ) : (
              <button className="btn ghost" onClick={onClose}>
                Done
              </button>
            )}
            <button className="lk mono" onClick={() => setRaw((r) => !r)}>
              raw log {raw ? "▾" : "▸"}
            </button>
          </div>
          {raw && <RawLog text={job.text} />}
        </div>
      </div>
    </section>
  );
}

function RawLog({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre className="raw" ref={ref}>
      {text || "…"}
    </pre>
  );
}

// Trunk = ports, three boughs = the three repos, leaves = env, Claude and T3, fruit = db, api, app.
function Tree({ v }: { v: LaunchView }) {
  const reached = (i: number) => v.current >= i || v.finished !== null;
  const on = (b: boolean) => (b ? " on" : "");
  return (
    <svg className="tree" width="190" height="200" viewBox="0 0 190 200" aria-hidden="true">
      <ellipse cx="95" cy="192" rx="60" ry="6" fill="#121b24" />
      <path className={`grow${on(reached(0))}`} style={{ "--len": 130 } as React.CSSProperties} d="M95 192 C95 160 95 120 95 64" stroke="#5b6b7d" strokeWidth="7" />
      <path className={`grow${on(reached(1))}`} style={{ "--len": 80 } as React.CSSProperties} d="M95 140 C80 130 60 126 44 108" stroke="#5b6b7d" strokeWidth="4.5" />
      <path className={`grow${on(reached(1))}`} style={{ "--len": 80 } as React.CSSProperties} d="M95 118 C112 108 130 104 148 86" stroke="#5b6b7d" strokeWidth="4.5" />
      <path className={`grow${on(reached(1))}`} style={{ "--len": 50 } as React.CSSProperties} d="M95 90 C88 80 84 70 78 52" stroke="#5b6b7d" strokeWidth="3.5" />
      <g className={`leaf${on(reached(2))}`}>
        <ellipse cx="40" cy="100" rx="13" ry="8" fill="#2f6b3d" transform="rotate(-30 40 100)" />
        <ellipse cx="56" cy="112" rx="10" ry="6" fill="#3e8a4f" transform="rotate(20 56 112)" />
      </g>
      <g className={`leaf${on(reached(3))}`}>
        <ellipse cx="152" cy="80" rx="13" ry="8" fill="#2f6b3d" transform="rotate(30 152 80)" />
        <ellipse cx="134" cy="98" rx="10" ry="6" fill="#3e8a4f" transform="rotate(-20 134 98)" />
      </g>
      <g className={`leaf${on(reached(4))}`}>
        <ellipse cx="76" cy="46" rx="11" ry="7" fill="#3e8a4f" transform="rotate(-60 76 46)" />
        <ellipse cx="96" cy="60" rx="14" ry="9" fill="#2f6b3d" />
      </g>
      <g className={`fruit${on(v.fruit.db)}`}>
        <circle className="halo" cx="58" cy="128" r="7" fill="var(--db)" />
        <circle cx="58" cy="128" r="7" fill="var(--db)" />
      </g>
      <g className={`fruit${on(v.fruit.api)}`}>
        <circle className="halo" cx="132" cy="112" r="7" fill="var(--api)" />
        <circle cx="132" cy="112" r="7" fill="var(--api)" />
      </g>
      <g className={`fruit${on(v.fruit.app)}`}>
        <circle className="halo" cx="95" cy="40" r="9" fill="var(--app)" />
        <circle cx="95" cy="40" r="9" fill="var(--app)" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// The receipt: a ticket stub with everything the launch summary printed, kept with the worktree.

export function Receipt({
  w,
  launch,
  job,
  caps,
  confetti,
  h,
}: {
  w: WorktreeView;
  launch: LaunchSummary | null;
  job?: JobState;
  caps: Capabilities | null;
  confetti: boolean;
  h: ReceiptHandlers;
}) {
  const up = isRunning(w);
  const startedAt = job?.startedAt ?? launch?.startedAt;
  const finishedAt = job?.finishedAt ?? launch?.finishedAt;
  const took = startedAt && finishedAt ? clock(finishedAt - startedAt) : null;
  const warnings = launch?.warnings ?? [];
  return (
    <div className="receipt">
      {confetti && <Confetti />}
      <div className="stub">
        <div className="l">
          <span className="admit mono">WORKTREE PASS</span>
          <div className="big mono">
            <span>#</span>
            {w.ticket}
          </div>
          <Barcode seed={w.ticket} />
        </div>
        <div className="r">
          <div className="rhead">
            {up ? <span className="live" style={{ color: "var(--app)" }} /> : <span className="off" />}
            <b className="mono">
              grubbs-{w.ticket} is {up ? "up" : "parked"}
            </b>
            <span className="t mono">
              {finishedAt ? `launched ${timeOf(finishedAt)}${took ? ` · took ${took}` : ""}` : "no launch on record"}
            </span>
          </div>
          <div className="prow">
            <span className="k" style={{ color: "var(--app)" }}>APP</span>
            <span className="p mono">:{w.fePort}</span>
            <span className="h mono">{hostOf(w.feUrl)}</span>
            <CopyChip text={w.feUrl ?? ""} label="app URL" copy={h.copy} className="cp mono" />
          </div>
          <div className="prow">
            <span className="k" style={{ color: "var(--api)" }}>API</span>
            <span className="p mono">:{w.webPort}</span>
            <span className="h mono">{hostOf(w.apiUrl)}</span>
            <CopyChip text={w.apiUrl ?? ""} label="API URL" copy={h.copy} className="cp mono" />
          </div>
          <div className="prow">
            <span className="k" style={{ color: "var(--db)" }}>DB</span>
            <span className="p mono">:{w.pgPort}</span>
            <span className="h mono">admin/admin · grubbs_db</span>
            <CopyChip text={psqlUrl(w)} label="Postgres URL" copy={h.copy} caption="url" className="cp mono" />
          </div>
          <div className="prow">
            <span className="k dim">BRANCH</span>
            <span className="p mono small wide">{w.branch}</span>
            <CopyChip text={w.path ?? ""} label="folder path" copy={h.copy} caption="path" className="cp mono" />
          </div>
          {warnings.map((why) => (
            <div className="rwarn" key={why}>
              <I.Warn size={12} /> {why}. The worktree is fine.
            </div>
          ))}
          <div className="ractions">
            <button className="rb go" onClick={h.open} disabled={!w.frontendUp}>
              Open app <I.Arrow size={11} />
            </button>
            {caps?.t3 && (
              <button className="rb t3" onClick={() => h.reveal("t3")}>
                <I.T3 /> Open in T3 Code
              </button>
            )}
            {caps?.terminal && (
              <button className="rb" onClick={() => h.reveal("terminal")}>
                <I.Term /> Terminal here
              </button>
            )}
            <CopyChip text={envBlock(w)} label=".env block" copy={h.copy} caption=".env block" className="rb mono" />
          </div>
        </div>
      </div>
      <div className="pinned">
        <I.Ticket size={12} /> Saved with the worktree: any card → Receipt. Survives reloads and restarts.
      </div>
    </div>
  );
}

// A barcode that is the same for the same ticket, so a ticket's stub always looks like itself.
function Barcode({ seed }: { seed: string }) {
  const bars = useMemo(() => {
    let x = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const out: { x: number; w: number }[] = [];
    for (let pos = 0; pos < 70; ) {
      x = (x * 1103515245 + 12345) >>> 0;
      const w = 1 + ((x >>> 16) % 4);
      out.push({ x: pos, w });
      pos += w + 1 + ((x >>> 20) % 2);
    }
    return out;
  }, [seed]);
  return (
    <svg width="70" height="26" viewBox="0 0 70 26" aria-hidden="true">
      <g fill="#3b4a5c">
        {bars.map((b) => (
          <rect key={b.x} x={b.x} y="0" width={b.w} height="26" />
        ))}
      </g>
    </svg>
  );
}

const CONFETTI = ["var(--app)", "var(--api)", "var(--db)", "var(--warn)", "#ff5fa2", "#e6edf3"];

function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 70 }, (_, k) => ({
        left: 5 + Math.random() * 90,
        color: CONFETTI[k % CONFETTI.length],
        x: Math.random() * 160 - 80,
        r: Math.random() * 900 - 450,
        d: 1.6 + Math.random() * 1.6,
        delay: Math.random() * 0.5,
        round: k % 3 === 0,
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((b, k) => (
        <i
          key={k}
          className={b.round ? "round" : undefined}
          style={
            {
              left: `${b.left}%`,
              background: b.color,
              "--x": `${b.x}px`,
              "--r": `${b.r}deg`,
              "--d": `${b.d}s`,
              "--delay": `${b.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
