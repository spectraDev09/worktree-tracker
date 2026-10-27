import { guard } from "@/lib/guard";
import { run } from "@/lib/script";

export const dynamic = "force-dynamic";

// POST /api/docker: start Docker Desktop. The list poll notices when it is up.
export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const r = await run("/usr/bin/open", ["-a", "Docker"], 10_000);
  return r.code === 0 ? Response.json({ ok: true }) : Response.json({ error: r.stderr.trim() }, { status: 500 });
}
