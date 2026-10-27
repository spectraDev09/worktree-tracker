import path from "node:path";
import { badTicket, guard } from "@/lib/guard";
import { reveal } from "@/lib/open";
import { listWorktrees } from "@/lib/script";
import type { RevealApp } from "@/lib/types";

export const dynamic = "force-dynamic";

const APPS = new Set<RevealApp>(["t3", "terminal", "editor", "finder"]);

// POST /api/worktrees/<t>/reveal {app}: the worktree folder in T3 Code, a terminal, the editor or
// Finder. The folder comes from the script, never from the request.
export async function POST(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  const denied = guard(req) ?? badTicket(ticket);
  if (denied) return denied;
  const { app } = (await req.json().catch(() => ({}))) as { app?: RevealApp };
  if (!app || !APPS.has(app)) return Response.json({ error: "unknown app" }, { status: 400 });
  const [w] = await listWorktrees({ git: false, ticket }).catch(() => []);
  if (!w?.path || !path.isAbsolute(w.path) || path.basename(w.path) !== `grubbs-${ticket}`) {
    return Response.json({ error: `no folder for #${ticket}` }, { status: 404 });
  }
  const r = await reveal(w.path, app);
  return r.code === 0
    ? Response.json({ opened: w.path })
    : Response.json({ error: r.stderr.trim() || `exited ${r.code}` }, { status: 500 });
}
