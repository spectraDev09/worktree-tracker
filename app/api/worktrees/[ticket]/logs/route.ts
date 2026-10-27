import { badTicket, guard } from "@/lib/guard";
import { runScript } from "@/lib/script";

export const dynamic = "force-dynamic";

// GET /api/worktrees/<t>/logs?which=frontend|backend: the last 200 lines, via the script.
export async function GET(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  const denied = guard(req) ?? badTicket(ticket);
  if (denied) return denied;
  const which = new URL(req.url).searchParams.get("which");
  if (which !== "frontend" && which !== "backend") {
    return Response.json({ error: "which must be frontend or backend" }, { status: 400 });
  }
  const r = await runScript(["logs", ticket, which, "200"], 20_000);
  if (r.code !== 0) return Response.json({ error: r.stderr.trim() || `exited ${r.code}` }, { status: 500 });
  return Response.json({ text: r.stdout });
}
