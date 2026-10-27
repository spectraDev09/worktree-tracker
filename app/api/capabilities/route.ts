import { guard } from "@/lib/guard";
import { capabilities } from "@/lib/open";

export const dynamic = "force-dynamic";

// GET /api/capabilities: which of T3 Code, an editor and a terminal the "open in" buttons can use.
export async function GET(req: Request) {
  return guard(req) ?? Response.json(capabilities());
}
