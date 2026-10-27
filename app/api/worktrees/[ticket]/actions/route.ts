import { badTicket, guard } from "@/lib/guard";
import { type Action, runningJobFor, startJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

type Body = { action?: string; force?: boolean; deleteBranches?: boolean };

// POST /api/worktrees/<t>/actions {action, force?, deleteBranches?}: starts a detached job.
export async function POST(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  const denied = guard(req) ?? badTicket(ticket);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Body;

  let action: Action;
  let args: string[];
  switch (body.action) {
    case "restart-frontend":
    case "restart-backend":
      action = body.action;
      args = [action, ticket];
      break;
    case "remove":
      action = "remove";
      args = ["remove", ticket];
      if (body.force === true) args.push("--force");
      if (body.deleteBranches === true) args.push("--delete-branches");
      break;
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }

  const busy = runningJobFor(ticket);
  if (busy) return Response.json({ error: `#${ticket} is busy: ${busy.action}` }, { status: 409 });
  return Response.json(startJob(ticket, action, args), { status: 202 });
}
