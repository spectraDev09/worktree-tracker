# Grubbs Worktrees

A local PWA that lists the Grubbs ticket worktrees (`~/code/Grubbs-worktrees/grubbs-<ticket>`, or
`$GRUBBS_WT_HOME`) and drives them, so nothing about a worktree needs a terminal:

- **Ports up front.** Each worktree is three sockets (APP lime, API cyan, DB violet), each with its
  port, whether it answers, its own restart / stop / start, and one-click copies (URL, Postgres URL,
  `psql` command, `.env` block).
- **⌘K** launches a ticket with every flag the script takes, showing the ports it will get before
  you press Enter. It also finds a worktree by ticket, branch or port ("who has :8003?").
- **The launch** shows as stages read from the script's own `==>` lines, with a tree that grows
  as they finish. A step that went wrong but did not stop the launch (T3 Code) turns amber.
- **The receipt.** When a launch finishes, its ports and URLs stay with the worktree (card →
  Receipt). A launch that finished while the window was closed has its receipt waiting at the top.
- **Open in** T3 Code, Terminal, the editor (Cursor, VS Code or Zed, whichever is installed) or
  Finder, right in the worktree folder. Logs follow in the card (app, api, the launch's own log).

It holds no worktree logic of its own. Every read and action goes through
`grubbs-worktree.sh` (the target of `~/.local/bin/launch-worktree`, override with `GRUBBS_WT_SCRIPT`):

| App                     | Script                                                   |
| ----------------------- | -------------------------------------------------------- |
| list, every 5s / 30s    | `ls --json --no-git` + `docker info` + an HTTP probe on each API |
| list, every 60s / focus | `ls --json` (adds the uncommitted-changes check)         |
| Start                   | `start <t>` (brings up what is down)                     |
| Stop / ■ on a socket    | `stop <t> [frontend\|backend]` (ports and data stay)      |
| ↻ / ▶ on APP            | `restart-frontend <t>`                                   |
| ↻ / ▶ on API            | `restart-backend <t>`                                    |
| Logs (re-read every 2s) | `logs <t> frontend\|backend 400`                         |
| Remove                  | `remove <t> [--force] [--delete-branches]`               |
| ⌘K → Launch             | `launch <t> [--backend-base b] [--frontend-base b] [--no-start] [--refresh-snapshot]` |
| ⌘K port preview         | `next-ports`                                             |
| Open                    | `open <FE_URL from .worktree.env>`                       |
| T3 Code / Terminal / …  | `t3 app <path>` (T3 Code's own CLI) / `open -a <app> <path>`, path from `ls --json` |

`start`, `stop`, `next-ports` and the `path` field of `ls --json` are newer than the rest of the
script; an older copy answers them with its usage text, which the app shows as the error.

## Install

```sh
npm install
npm run build
npm run agent:install     # launchd agent: starts now and at every login, restarts if it dies
```

Then open <http://127.0.0.1:7420> in Chrome → ⋮ → **Cast, save and share → Install page as app**.
It gets its own window and Dock icon; the Dock badge is the number of worktrees with anything running.

After changing the code: `npm run build && npm run agent:install`.
Remove: `npm run agent:uninstall`. Status: `npm run agent:status`. Server log: `~/Library/Logs/grubbs-worktrees.log`.

`npm run dev` serves a dev copy on :7421 next to the installed one.

## How it behaves

- **Receipts.** Finished jobs are deleted after two days, except each live worktree's newest launch:
  that job is its receipt, kept until the worktree is removed. Which receipts were already seen is
  kept in the browser (`localStorage`).
- **The API probe** asks for `/?worktrees-probe`, and the API log view hides those lines, so its
  own polling does not bury real requests.
- **Nothing the app starts depends on the app.** Each action runs the script detached, in its own
  process group, with output in `~/Library/Application Support/Grubbs Worktrees/jobs/`. Closing the
  window, or stopping or restarting the server, leaves frontends, backends and a half-done remove running;
  the exit code still lands in the job's `.exit` file, so the spinner and the result come back.
- **PATH.** launchd gives a minimal environment. Children get
  `/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin` and a terminal-like
  environment, not the server's (`next start` sets `NODE_ENV=production`, which would break `pnpm install`
  and `next dev` in a worktree).
- **Security.** It listens on 127.0.0.1 only. Requests must carry a loopback `Host` (no DNS rebinding),
  no cross-site `Origin` / `Sec-Fetch-Site`, and mutating requests need an `x-grubbs-worktrees: 1` header
  (a foreign page can't send it without a CORS preflight, which is never approved). Tickets must match
  `^\d+$`; every command is `execFile`/`spawn` with an argv array.
- **Remove** asks first, listing what goes (three worktrees, containers and the database volume, the
  folder, the T3 project and chats). If the script refuses over uncommitted changes, it lists the dirty
  repos and offers **Force remove**, which needs the ticket number typed in.
- **Docker not running:** a banner with **Start Docker**, and backend actions, the API log and Remove
  are disabled (a remove then could not delete the containers and the database volume).
- **Keys:** ⌘K launch or find, `1`–`9` pick a worktree, then `o` open the app, `c` copy its URL,
  `l` logs, `t` T3 Code. A launch that finishes while the window is hidden sends a notification.
