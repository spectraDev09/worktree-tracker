import { badTicket, guard } from "@/lib/guard";
import { runningJobFor, startJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// POST /api/launch {ticket}: launch-worktree <ticket>, detached. The first run can take many
// minutes because it builds the database snapshot.
export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { ticket } = (await req.json().catch(() => ({}))) as { ticket?: unknown };
  const t = String(ticket ?? "").replace(/^#/, "");
  const bad = badTicket(t);
  if (bad) return bad;
  const busy = runningJobFor(t);
  if (busy) return Response.json({ error: `#${t} is busy: ${busy.action}` }, { status: 409 });
  return Response.json(startJob(t, "launch", ["launch", t]), { status: 202 });
}
