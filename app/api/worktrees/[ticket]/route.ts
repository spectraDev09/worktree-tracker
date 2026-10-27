import { badTicket, guard } from "@/lib/guard";
import { listWorktrees } from "@/lib/script";

export const dynamic = "force-dynamic";

// GET /api/worktrees/<t>: one worktree with a fresh uncommitted-changes check, for the remove dialog.
export async function GET(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  const denied = guard(req) ?? badTicket(ticket);
  if (denied) return denied;
  try {
    const [w] = await listWorktrees({ git: true, ticket });
    return w ? Response.json(w) : Response.json({ error: `no worktree grubbs-${ticket}` }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
