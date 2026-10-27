import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Capabilities, RevealApp } from "./types";
import { type RunResult, run } from "./script";

// Opens a worktree folder in the apps a developer would otherwise cd into it for. Each is looked
// up once per call in the usual places; GRUBBS_WT_EDITOR / GRUBBS_WT_TERMINAL pick another app.

const APP_DIRS = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications/Utilities"];

const appPath = (name: string) =>
  APP_DIRS.map((d) => path.join(d, `${name}.app`)).find((p) => fs.existsSync(p)) ?? null;

const firstApp = (override: string | undefined, names: string[]) =>
  [override, ...names].find((n): n is string => !!n && appPath(n) !== null) ?? null;

const editor = () => firstApp(process.env.GRUBBS_WT_EDITOR, ["Cursor", "Visual Studio Code", "Zed", "Windsurf"]);
const terminal = () => firstApp(process.env.GRUBBS_WT_TERMINAL, ["Ghostty", "iTerm", "Warp", "Terminal"]);

// The same channel order grubbs-worktree.sh uses, so both talk to the same T3 Code.
function t3App(): string | null {
  const own = process.env.T3_APP;
  if (own) return fs.existsSync(own) ? own : null;
  return ["T3 Code (Alpha)", "T3 Code (Beta)", "T3 Code"].map(appPath).find((p) => p !== null) ?? null;
}

export const capabilities = (): Capabilities => ({ t3: t3App() !== null, editor: editor(), terminal: terminal() });

export async function reveal(dir: string, app: RevealApp): Promise<RunResult> {
  switch (app) {
    case "finder":
      return run("/usr/bin/open", [dir], 10_000);
    case "terminal":
    case "editor": {
      const name = app === "editor" ? editor() : terminal();
      if (!name) return { code: 1, stdout: "", stderr: `no ${app} app found` };
      return run("/usr/bin/open", ["-a", name, dir], 10_000);
    }
    case "t3": {
      // `t3 app <dir>` asks the running desktop app to open (and if needed add) the project.
      const t3 = t3App();
      if (!t3) return { code: 1, stdout: "", stderr: "T3 Code is not installed" };
      const bin = path.join(t3, "Contents/MacOS", path.basename(t3, ".app"));
      const cli = path.join(t3, "Contents/Resources/app.asar/apps/server/dist/bin.mjs");
      return run(bin, [cli, "app", dir], 20_000, { ELECTRON_RUN_AS_NODE: "1" });
    }
  }
}
