# Grubbs Worktrees

A local PWA that lists the Grubbs ticket worktrees (`~/code/Grubbs-worktrees/grubbs-<ticket>`, or
`$GRUBBS_WT_HOME`) and drives them: open the frontend, restart the frontend or the backend, read
either log, remove a worktree, launch a new one.

It holds no worktree logic of its own. Every read and action goes through
`grubbs-worktree.sh` (the target of `~/.local/bin/launch-worktree`, override with `GRUBBS_WT_SCRIPT`):

| App                     | Script                                                   |
| ----------------------- | -------------------------------------------------------- |
| list, every 5s / 30s    | `ls --json --no-git` + `docker info` + an HTTP probe on each API |
| list, every 60s / focus | `ls --json` (adds the uncommitted-changes check)         |
| Restart frontend        | `restart-frontend <t>`                                   |
| Restart backend         | `restart-backend <t>`                                    |
| Logs                    | `logs <t> frontend\|backend 200`                         |
| Remove                  | `remove <t> [--force] [--delete-branches]`               |
| New worktree            | `launch <t>`                                             |
| Open                    | `open <FE_URL from .worktree.env>`                       |

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
- **Docker not running:** a banner, and Restart backend, Backend log and Remove are disabled (a remove
  then could not delete the containers and the database volume).
