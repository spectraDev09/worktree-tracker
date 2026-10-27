import { guard } from "@/lib/guard";
import { runningJobs } from "@/lib/jobs";
import { apiAnswers, dockerUp, listWorktrees } from "@/lib/script";

export const dynamic = "force-dynamic";

// GET /api/worktrees[?git=1]: the fast poll leaves git out (dirty is null), the slow one adds it.
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const git = new URL(req.url).searchParams.get("git") === "1";
  try {
    const [docker, worktrees] = await Promise.all([dockerUp(), listWorktrees({ git })]);
    const withApi = await Promise.all(
      worktrees.map(async (w) => ({
        ...w,
        apiAnswering: docker && w.containersRunning > 0 && w.apiUrl ? await apiAnswers(w.apiUrl) : false,
      })),
    );
    return Response.json({ docker, git, worktrees: withApi, jobs: runningJobs(), checkedAt: Date.now() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
