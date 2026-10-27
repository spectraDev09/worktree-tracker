import { guard } from "@/lib/guard";
import { scanJobs } from "@/lib/jobs";
import { apiAnswers, dockerUp, listWorktrees } from "@/lib/script";

export const dynamic = "force-dynamic";

// GET /api/worktrees[?git=1]: the fast poll leaves git out (dirty is null), the slow one adds it.
// Each worktree carries its newest launch, which is what its receipt is made of.
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const git = new URL(req.url).searchParams.get("git") === "1";
  try {
    const [docker, worktrees] = await Promise.all([dockerUp(), listWorktrees({ git })]);
    const { running, launches } = scanJobs(new Set(worktrees.map((w) => w.ticket)));
    const withApi = await Promise.all(
      worktrees.map(async (w) => ({
        ...w,
        apiAnswering: docker && w.containersRunning > 0 && w.apiUrl ? await apiAnswers(w.apiUrl) : false,
        lastLaunch: launches[w.ticket] ?? null,
      })),
    );
    return Response.json({ docker, git, worktrees: withApi, jobs: running, checkedAt: Date.now() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
