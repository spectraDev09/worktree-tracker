import { badTicket, guard } from "@/lib/guard";
import { listWorktrees, run } from "@/lib/script";

export const dynamic = "force-dynamic";

// POST /api/worktrees/<t>/open: FE_URL from the worktree's own .worktree.env, in the default browser.
export async function POST(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  const denied = guard(req) ?? badTicket(ticket);
  if (denied) return denied;
  const [w] = await listWorktrees({ git: false, ticket }).catch(() => []);
  if (!w?.feUrl || !/^https?:\/\//.test(w.feUrl)) {
    return Response.json({ error: `no frontend URL for #${ticket}` }, { status: 404 });
  }
  const r = await run("/usr/bin/open", [w.feUrl], 10_000);
  return r.code === 0 ? Response.json({ opened: w.feUrl }) : Response.json({ error: r.stderr }, { status: 500 });
}
