import { guard } from "@/lib/guard";
import { nextPorts } from "@/lib/script";

export const dynamic = "force-dynamic";

// GET /api/next-ports: the ports a launch would give a new ticket now, for the launcher's preview.
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    return Response.json(await nextPorts());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
