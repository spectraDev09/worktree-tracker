"use client";

import { useEffect, useRef, useState } from "react";
import type { Ports, WorktreeView } from "@/lib/types";
import { Dot } from "./Card";
import { api, isRunning, services } from "./client";
import * as I from "./icons";

export type LaunchOpts = {
  backendBase: string;
  frontendBase: string;
  start: boolean;
  refreshSnapshot: boolean;
  openWhenUp: boolean;
};

export const DEFAULT_OPTS: LaunchOpts = { backendBase: "", frontendBase: "", start: true, refreshSnapshot: false, openWhenUp: true };

type Item = { kind: "launch"; ticket: string } | { kind: "jump"; w: WorktreeView; why: string | null };

export const commandFor = (ticket: string, o: LaunchOpts) =>
  [
    "launch-worktree",
    ticket,
    ...(o.backendBase.trim() ? ["--backend-base", o.backendBase.trim()] : []),
    ...(o.frontendBase.trim() ? ["--frontend-base", o.frontendBase.trim()] : []),
    ...(o.start ? [] : ["--no-start"]),
    ...(o.refreshSnapshot ? ["--refresh-snapshot"] : []),
  ].join(" ");

// ⌘K: type a ticket to launch it (with every flag the script takes, and the ports it will get),
// or a ticket, branch or port to jump to the worktree that has it.
export function Launcher({
  worktrees,
  docker,
  busy,
  onClose,
  onLaunch,
  onJump,
}: {
  worktrees: WorktreeView[];
  docker: boolean | null;
  busy: Set<string>;
  onClose: () => void;
  onLaunch: (ticket: string, o: LaunchOpts) => void;
  onJump: (ticket: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [opts, setOpts] = useState<LaunchOpts>(DEFAULT_OPTS);
  const [ports, setPorts] = useState<Ports | null | "loading">("loading");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("gw.launchOpts") ?? "null");
      if (saved) setOpts({ ...DEFAULT_OPTS, openWhenUp: saved.openWhenUp ?? true });
    } catch {}
    api<Ports>("/api/next-ports")
      .then(setPorts)
      .catch(() => setPorts(null));
    input.current?.focus();
  }, []);

  const t = q.trim().replace(/^#/, "");
  const isTicket = /^\d+$/.test(t);
  const exact = worktrees.find((w) => w.ticket === t);
  const portOwner = (w: WorktreeView) =>
    ([["app", w.fePort], ["api", w.webPort], ["db", w.pgPort]] as const).find(([, p]) => p !== null && String(p) === t);
  const jumps: Item[] = worktrees
    .filter((w) => !t || w.ticket.includes(t) || portOwner(w) || (w.branch ?? "").includes(t))
    .map((w) => {
      const owner = portOwner(w);
      return { kind: "jump", w, why: owner ? `owns ${owner[0]} :${owner[1]}` : null };
    });
  // A number that is some worktree's port is more likely a search than a new ticket.
  const launchItem: Item[] = isTicket && !exact ? [{ kind: "launch", ticket: t }] : [];
  const portHit = jumps.some((it) => it.kind === "jump" && it.why);
  const items: Item[] = portHit ? [...jumps, ...launchItem] : [...launchItem, ...jumps];
  const launchAt = items.findIndex((it) => it.kind === "launch");
  const cur = items[Math.min(sel, items.length - 1)];
  const launching = cur?.kind === "launch";

  useEffect(() => setSel(0), [q]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === "jump") return onJump(it.w.ticket);
    if (busy.has(it.ticket)) return;
    localStorage.setItem("gw.launchOpts", JSON.stringify({ openWhenUp: opts.openWhenUp }));
    onLaunch(it.ticket, opts);
  };

  const set = <K extends keyof LaunchOpts>(k: K, v: LaunchOpts[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const needsDocker = launching && opts.start && docker === false;

  return (
    <div className="palette-bg" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Launch or jump"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target !== input.current) return;
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === "Enter") {
            // Enter launches from anywhere but a real button; a switch flips with Space, like a checkbox.
            const el = e.target as HTMLElement;
            if (el instanceof HTMLButtonElement && el.getAttribute("role") !== "switch") return;
            e.preventDefault();
            if (!needsDocker) choose(cur);
          }
        }}
      >
        <div className="pin mono">
          <span className="pfx">#</span>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ticket, branch or port"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>esc</kbd>
        </div>

        {items.length === 0 && (
          <div className="sect empty-sect">
            {t ? (
              <>
                Nothing has <span className="mono">{t}</span>. A ticket is a number, like <span className="mono">2140</span>.
              </>
            ) : (
              "No worktrees yet. Type a ticket number to launch the first one."
            )}
          </div>
        )}

        {launchAt >= 0 && (
          <div className="sect" style={launchAt === 0 ? { order: 0 } : { order: 2, borderTop: "1px solid var(--line)" }}>
            <h6>LAUNCH</h6>
            <div className={`opt${launching ? " sel" : ""}`} onMouseEnter={() => setSel(launchAt)} onClick={() => choose(items[launchAt])}>
              <span className="ic">
                <I.Plus size={15} />
              </span>
              <span className="t">
                <b>Launch #{t}</b> <span className="dim mono">mithilesh/{t}</span>
                <small>
                  new worktree from {opts.backendBase.trim() || "origin/dev"}
                  {opts.frontendBase.trim() && opts.frontendBase.trim() !== (opts.backendBase.trim() || "origin/dev")
                    ? ` (frontend from ${opts.frontendBase.trim()})`
                    : ""}
                  {opts.start ? " · starts both stacks" : " · nothing started"}
                </small>
              </span>
              <span className="slot mono" title="The ports this launch will reserve, if nothing else takes them first">
                {ports === "loading" ? (
                  <span className="faint">
                    <span className="spin" /> ports
                  </span>
                ) : ports ? (
                  <>
                    <span className="pchip app">
                      <i />:{ports.fePort}
                    </span>
                    <span className="pchip api">
                      <i />:{ports.webPort}
                    </span>
                    <span className="pchip db">
                      <i />:{ports.pgPort}
                    </span>
                  </>
                ) : null}
              </span>
            </div>
            {launching && (
              <>
                <div className="grid2">
                  <label className="field">
                    <span>CRM-BACKEND BASE</span>
                    <input
                      className="mono"
                      value={opts.backendBase}
                      onChange={(e) => set("backendBase", e.target.value)}
                      placeholder="origin/dev"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>CRM-FRONTEND BASE</span>
                    <input
                      className="mono"
                      value={opts.frontendBase}
                      onChange={(e) => set("frontendBase", e.target.value)}
                      placeholder={opts.backendBase.trim() || "origin/dev"}
                      spellCheck={false}
                    />
                  </label>
                </div>
                <div className="toggles">
                  <Toggle on={opts.start} set={(v) => set("start", v)} label="Start stacks" />
                  <Toggle on={opts.refreshSnapshot} set={(v) => set("refreshSnapshot", v)} label="Rebuild DB snapshot" disabled={!opts.start} />
                  <Toggle on={opts.openWhenUp && opts.start} set={(v) => set("openWhenUp", v)} label="Open app when up" disabled={!opts.start} />
                </div>
                <p className="hint">
                  A base only matters for a branch that does not exist yet. The first launch after a migration change
                  rebuilds the database snapshot, which takes a few minutes.
                </p>
                <div className="cmdline mono">
                  <span className="faint">$</span> {commandFor(t, opts)}
                </div>
              </>
            )}
          </div>
        )}

        {jumps.length > 0 && (
          <div className="sect" style={{ order: 1, ...(launchAt === 0 ? { borderTop: "1px solid var(--line)" } : {}) }}>
            <h6>{t ? "JUMP TO" : "WORKTREES"}</h6>
            {jumps.map((it, k) => {
              if (it.kind !== "jump") return null;
              const i = k + (launchAt === 0 ? 1 : 0);
              const svc = services(it.w, docker);
              return (
                <div
                  key={it.w.ticket}
                  className={`opt${i === Math.min(sel, items.length - 1) ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(it)}
                >
                  <span className="ic mono">#</span>
                  <span className="t">
                    <b>#{it.w.ticket}</b> <span className="dim mono">{it.w.branch}</span>
                    {it.why && <span className="why mono">{it.why}</span>}
                    {!isRunning(it.w) && <span className="faint"> · parked</span>}
                  </span>
                  <span className="slot mono">
                    <span className={`pchip app s-${svc.app}`}>
                      <Dot s={svc.app} />:{it.w.fePort}
                    </span>
                    <span className={`pchip api s-${svc.api}`}>
                      <Dot s={svc.api} />:{it.w.webPort}
                    </span>
                    <span className={`pchip db s-${svc.db}`}>
                      <Dot s={svc.db} />:{it.w.pgPort}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="pfoot">
          <span className="eta">
            <kbd>↑↓</kbd> move
          </span>
          <span className="eta">
            <kbd>↵</kbd> {launching ? "launch" : "jump"}
          </span>
          {launching ? (
            <>
              <span className="spacer" />
              <button className="go" onClick={() => choose(cur)} disabled={needsDocker || busy.has(t)}>
                {needsDocker ? "Docker is off" : "Launch"} <kbd>↵</kbd>
              </button>
            </>
          ) : (
            <span className="faint">type a new ticket number to launch it</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, set, label, disabled }: { on: boolean; set: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button className="tog" role="switch" aria-checked={on} onClick={() => set(!on)} disabled={disabled}>
      <span className={`sw${on ? " on" : ""}`} />
      {label}
    </button>
  );
}
