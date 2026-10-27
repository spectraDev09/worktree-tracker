"use client";

import type { WorktreeView } from "@/lib/types";
import * as I from "./icons";

export type RemoveDialog = {
  ticket: string;
  stage: "confirm" | "force";
  deleteBranches: boolean;
  fresh?: WorktreeView;
  checking: boolean;
  error?: string;
  typed: string;
};

export function RemoveModal({
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
    <div className="modal-bg" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className={`modal ${force ? "force" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <I.Trash size={15} /> {force ? `Force remove #${d.ticket}?` : `Remove #${d.ticket}?`}
        </h3>

        {force && (
          <div className="warn-box">
            <strong>remove-worktree refused:</strong> these repos have uncommitted changes. Force remove deletes them
            for good.
            {d.checking ? (
              <p>
                <span className="spin" /> checking…
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
        <p className="muted">
          Its ports go back to the pool. To keep the worktree and only free memory, use <b>Stop</b> instead.
        </p>

        {!force && d.checking && (
          <p className="muted">
            <span className="spin" /> checking for uncommitted changes…
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
          <span>
            Also delete branch <code>{branch}</code>{" "}
            <span className="muted">
              {force ? "(even when not merged)" : "(only where merged; unmerged branches are kept)"}
            </span>
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
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className={force ? "btn danger solid" : "btn danger"} disabled={!canConfirm} onClick={() => onConfirm(d)}>
            {force ? "Force remove" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
