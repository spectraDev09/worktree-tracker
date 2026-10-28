#!/usr/bin/env node
// Install, remove or inspect the launchd agent that keeps the server running:
//   node scripts/agent.mjs install     (after `npm run build`; starts it now and at every login)
//   node scripts/agent.mjs uninstall
//   node scripts/agent.mjs status
//
// The agent runs `next start` on 127.0.0.1:7420 with the node binary that ran this script, the
// PATH a terminal would have (docker, python3, ~/.local/bin), and AbandonProcessGroup so that
// stopping the agent never takes a frontend or a backend down with it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.grubbs.worktrees";
const PORT = process.env.GRUBBS_WORKTREES_PORT || "7420";
const HOME = os.homedir();
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLIST = path.join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const LOG = path.join(HOME, "Library/Logs/grubbs-worktrees.log");
const DOMAIN = `gui/${process.getuid()}`;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (s) => `<string>${esc(s)}</string>`;

function plist() {
  const env = {
    PATH: `/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const k of ["GRUBBS_ROOT", "GRUBBS_WT_HOME", "GRUBBS_WT_SCRIPT", "GRUBBS_WT_PREFIX", "NODE20_BIN"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const args = [process.execPath, path.join(APP_DIR, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", PORT];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${args.map(str).join("\n    ")}
  </array>
  <key>WorkingDirectory</key>${str(APP_DIR)}
  <key>EnvironmentVariables</key>
  <dict>
    ${Object.entries(env).map(([k, v]) => `<key>${esc(k)}</key>${str(v)}`).join("\n    ")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key>${str("Interactive")}
  <key>StandardOutPath</key>${str(LOG)}
  <key>StandardErrorPath</key>${str(LOG)}
</dict>
</plist>
`;
}

const launchctl = (...args) => execFileSync("/bin/launchctl", args, { stdio: "pipe" }).toString();

function loaded() {
  try {
    launchctl("print", `${DOMAIN}/${LABEL}`);
    return true;
  } catch {
    return false;
  }
}

// bootout returns before the job is gone, and bootstrapping over it fails with error 5
function bootout() {
  try {
    launchctl("bootout", `${DOMAIN}/${LABEL}`);
  } catch {}
  for (let i = 0; i < 50 && loaded(); i++) execFileSync("/bin/sleep", ["0.2"]);
}

switch (process.argv[2]) {
  case "install": {
    if (!fs.existsSync(path.join(APP_DIR, ".next/BUILD_ID"))) {
      console.error("no production build — run `npm run build` first");
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plist());
    bootout();
    launchctl("bootstrap", DOMAIN, PLIST);
    console.log(`installed ${PLIST}`);
    console.log(`node     ${process.execPath}`);
    console.log(`log      ${LOG}`);
    console.log(`open     http://127.0.0.1:${PORT}  then Chrome ⋮ → Cast, save and share → Install page as app`);
    break;
  }
  case "uninstall":
    bootout();
    fs.rmSync(PLIST, { force: true });
    console.log(`removed ${LABEL}`);
    break;
  case "status":
    try {
      console.log(launchctl("print", `${DOMAIN}/${LABEL}`).split("\n").filter((l) => /state =|pid =|last exit/.test(l)).join("\n"));
    } catch {
      console.log("not loaded");
    }
    break;
  default:
    console.error("usage: node scripts/agent.mjs install|uninstall|status");
    process.exit(1);
}
