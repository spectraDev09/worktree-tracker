import { badTicket, guard } from "@/lib/guard";
import { runningJobFor, startJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

type Body = {
  ticket?: unknown;
  backendBase?: unknown;
  frontendBase?: unknown;
  noStart?: unknown;
  refreshSnapshot?: unknown;
};

// A branch name for --backend-base / --frontend-base. It travels as its own argv entry, so this
// only has to keep it from reading as an option.
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;

// POST /api/launch {ticket, backendBase?, frontendBase?, noStart?, refreshSnapshot?}:
// launch-worktree <ticket> [flags], detached. The first run after a migration change rebuilds the
// database snapshot and can take many minutes.
export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Body;
  const t = String(body.ticket ?? "").replace(/^#/, "");
  const bad = badTicket(t);
  if (bad) return bad;

  const args = ["launch", t];
  for (const [flag, value] of [["--backend-base", body.backendBase], ["--frontend-base", body.frontendBase]] as const) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !BRANCH_RE.test(value)) {
      return Response.json({ error: `${flag} must be a branch name` }, { status: 400 });
    }
    args.push(flag, value);
  }
  if (body.noStart === true) args.push("--no-start");
  if (body.refreshSnapshot === true) args.push("--refresh-snapshot");

  const busy = runningJobFor(t);
  if (busy) return Response.json({ error: `#${t} is busy: ${busy.action}` }, { status: 409 });
  return Response.json(startJob(t, "launch", args), { status: 202 });
}
