import { guard } from "@/lib/guard";
import { readJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// GET /api/jobs/<id>?offset=n: status plus the output written since byte n.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await params;
  const offset = Math.max(0, parseInt(new URL(req.url).searchParams.get("offset") ?? "0", 10) || 0);
  const job = readJob(id, offset);
  return job ? Response.json(job) : Response.json({ error: "no such job" }, { status: 404 });
}
