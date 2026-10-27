import { badTicket, guard } from "@/lib/guard";
import { runningJobFor, startJob } from "@/lib/jobs";
import type { Action } from "@/lib/types";

export const dynamic = "force-dynamic";

type Body = { action?: string; force?: boolean; deleteBranches?: boolean };

// The script command behind each action that needs nothing but the ticket.
const SIMPLE: Partial<Record<Action, (t: string) => string[]>> = {
  start: (t) => ["start", t],
  stop: (t) => ["stop", t],
  "stop-frontend": (t) => ["stop", t, "frontend"],
  "stop-backend": (t) => ["stop", t, "backend"],
  "restart-frontend": (t) => ["restart-frontend", t],
  "restart-backend": (t) => ["restart-backend", t],
};

// POST /api/worktrees/<t>/actions {action, force?, deleteBranches?}: starts a detached job.
export async function POST(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  const denied = guard(req) ?? badTicket(ticket);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Body;

  let action: Action;
  let args: string[];
  if (body.action === "remove") {
    action = "remove";
    args = ["remove", ticket];
    if (body.force === true) args.push("--force");
    if (body.deleteBranches === true) args.push("--delete-branches");
  } else if (body.action && Object.hasOwn(SIMPLE, body.action)) {
    action = body.action as Action;
    args = SIMPLE[action]!(ticket);
  } else {
    return Response.json({ error: "unknown action" }, { status: 400 });
  }

  const busy = runningJobFor(ticket);
  if (busy) return Response.json({ error: `#${ticket} is busy: ${busy.action}` }, { status: 409 });
  return Response.json(startJob(ticket, action, args), { status: 202 });
}
