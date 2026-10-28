#!/usr/bin/env bash
# One folder per ticket, holding crm-backend, crm-frontend and engineering-playbook on
# <prefix>/<ticket>, with its own backend stack (restored from a seeded snapshot) and frontend.
#
#   launch-worktree <ticket> [--refresh-snapshot]   create or resume grubbs-<ticket> and start it
#   launch-worktree <ticket> --no-start             worktrees, env files and Claude setup only
#   launch-worktree <ticket> --base <branch>        cut backend + frontend from <branch> instead of dev
#                            --backend-base <b> / --frontend-base <b> set one repo only
#   (the base only matters when <prefix>/<ticket> does not exist yet; the playbook is always cut from main)
#   worktree-ls [<ticket>] [--json] [--no-git]      list worktrees, URLs and what is running
#                                                   --json: one array for tools, --no-git: skip the
#                                                   slow uncommitted-changes check (dirty is null)
#   remove-worktree <ticket> [--force] [--delete-branches]
#   grubbs-worktree.sh install                      link the three commands into ~/.local/bin
#   grubbs-worktree.sh frontend <ticket>            restart the frontend in this terminal
#   grubbs-worktree.sh backend <ticket>             start the stack, restart web + Celery, follow its log
#   grubbs-worktree.sh restart-frontend <ticket>    restart next dev detached; exit once it listens
#   grubbs-worktree.sh restart-backend <ticket>     start the stack, restart web + Celery; exit once it answers
#   grubbs-worktree.sh logs <ticket> frontend|backend [<lines>]   tail of either log, no follow
#   grubbs-worktree.sh start <ticket>               start whatever is stopped; exit once both answer
#   grubbs-worktree.sh stop <ticket> [frontend|backend]   stop it; ports, database and worktrees stay
#   grubbs-worktree.sh next-ports                   the ports a new worktree would get now, as JSON
#   (frontend and backend run in the foreground for T3's buttons; restart-*, start and stop are for apps)
#
# T3 Code: when the app is installed and open, launch-worktree adds grubbs-<ticket> as a T3
# project with "Frontend" and "Backend" action buttons that run the frontend and backend commands above, and
# remove-worktree deletes that project, its chats and its buttons again.
#
# Layout: <workspace>/../Grubbs-worktrees/grubbs-<ticket>/{crm-backend,crm-frontend,engineering-playbook}
#   .worktree.env        ports and URLs for this ticket (kept for the worktree's lifetime)
#   .worktree/           compose override, frontend pid, logs
#   CLAUDE.md, .claude/  links to the workspace's, so a Claude session opened here has the
#                        skills, agents and guard hooks; workspace.json and launch.json are its own
#
# The database comes from Grubbs-worktrees/.snapshots/dev-<hash>.dump: origin/dev migrated and
# seeded once, rebuilt when origin/dev's migrations change. A new worktree restores it in seconds
# and its web container then applies only the branch's own migrations.
#
# Overrides: GRUBBS_WT_HOME, GRUBBS_WT_PREFIX (default mithilesh), NODE20_BIN, CRM_WT_IMAGE,
#            T3_APP (default: the first of T3 Code (Alpha|Beta).app, T3 Code.app in /Applications),
#            T3CODE_HOME (default ~/.t3).
# Written for macOS bash 3.2 — no associative arrays, no mapfile.

set -euo pipefail

# Follow only the ~/.local/bin link, never the rest: <workspace>/.claude is itself a symlink into
# engineering-playbook, and resolving through it would make the playbook the workspace root.
SELF="$0"
[ -L "$SELF" ] && SELF="$(readlink "$SELF")"
SELF="$(cd "$(dirname "$SELF")" && pwd)/$(basename "$SELF")"
# This copy lives in the worktree-tracker app, not in <workspace>/.claude/scripts, so the workspace
# root cannot come from where the script sits: GRUBBS_ROOT, else ~/code/Grubbs.
ROOT="$(cd "${GRUBBS_ROOT:-$HOME/code/Grubbs}" && pwd)"
WT_HOME="${GRUBBS_WT_HOME:-$(dirname "$ROOT")/Grubbs-worktrees}"
PREFIX="${GRUBBS_WT_PREFIX:-mithilesh}"
SNAP_DIR="$WT_HOME/.snapshots"
BIN_DIR="$HOME/.local/bin"
T3_APP="${T3_APP:-}"
if [ -z "$T3_APP" ]; then  # whichever channel is installed; the last one stands for "not installed"
  for T3_APP in "/Applications/T3 Code (Alpha).app" "/Applications/T3 Code (Beta).app" "/Applications/T3 Code.app"; do
    [ -d "$T3_APP" ] && break
  done
fi
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"

SEEDS='python manage.py populate_users
python manage.py populate_groups
python manage.py import_localities
python manage.py inject_customers --count 50000 --no-confirm
python manage.py inject_projects --count 5000 --no-confirm
python manage.py populate_colours
python manage.py seed_legacy_project_properties'

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# Workspace facts

repo_path() {  # role -> absolute path of the main checkout, or empty
  [ -f "$ROOT/.claude/workspace.json" ] || "$ROOT/.claude/scripts/detect-repos.py" --quiet
  python3 -c 'import json,os,sys; d=json.load(open(sys.argv[1])); r=d["repos"].get(sys.argv[2]); print(os.path.join(d.get("workspace") or sys.argv[3], r["path"]) if r else "")' \
    "$ROOT/.claude/workspace.json" "$1" "$ROOT"
}

node20_bin() {
  if [ -n "${NODE20_BIN:-}" ]; then echo "$NODE20_BIN"; return; fi
  local d
  d="$(find "$HOME/.nvm/versions/node" -maxdepth 1 -name 'v20.*' 2>/dev/null | sort -t. -k2,2n -k3,3n | tail -1)"
  [ -n "$d" ] || die "no Node 20 under ~/.nvm/versions/node — set NODE20_BIN"
  echo "$d/bin"
}

web_image() {  # the image the main stack built; the worktree compose file only reuses it
  if [ -n "${CRM_WT_IMAGE:-}" ]; then echo "$CRM_WT_IMAGE"; return; fi
  local project candidate
  project="$(basename "$BACKEND" | tr '[:upper:]' '[:lower:]')"
  for candidate in "$project-web:latest" crm-backend-web:latest crm_backend-web:latest; do
    docker image inspect "$candidate" >/dev/null 2>&1 && { echo "$candidate"; return; }
  done
  die "no backend image found — build it once from $BACKEND: docker compose -f dev-compose.yml build web"
}

ticket_of() {
  local t="${1:-}"
  t="${t#\#}"
  [ -n "$t" ] || die "missing ticket number. In zsh a bare #1832 is a comment when interactivecomments is on — type 1832 or '#1832'"
  case "$t" in *[!0-9]*) die "ticket must be a number, got '$1'" ;; esac
  echo "$t"
}

# ---------------------------------------------------------------------------------------------
# Small helpers

set_env() {  # set_env <file> <KEY> <value>: replace the KEY= line or append it
  python3 - "$1" "$2" "$3" <<'PY'
import re, sys
path, key, val = sys.argv[1:4]
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except FileNotFoundError:
    lines = []
out, done = [], False
for line in lines:
    if re.match(rf"^{re.escape(key)}=", line):
        if not done:
            out.append(f"{key}={val}")
            done = True
        continue
    out.append(line)
if not done:
    out.append(f"{key}={val}")
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

reserved_ports() {  # ports promised to other worktrees, whether or not their stacks are up
  cat "$WT_HOME"/grubbs-*/.worktree.env 2>/dev/null | sed -n 's/^[A-Z]*_PORT=//p' || true
}

pick_ports() {  # sets WEB_PORT PG_PORT FE_PORT to the first free slot
  local n reserved p taken
  reserved=" $(reserved_ports | tr '\n' ' ') "
  for n in $(seq 1 60); do
    WEB_PORT=$((8000 + n)); PG_PORT=$((5432 + n)); FE_PORT=$((3020 + n)); taken=0
    for p in "$WEB_PORT" "$PG_PORT" "$FE_PORT"; do
      case "$reserved" in *" $p "*) taken=1 ;; esac
      port_busy "$p" && taken=1
    done
    [ "$taken" -eq 0 ] && return 0
  done
  die "no free port slot in 1..60"
}

copy_env_files() {  # copy_env_files <src> <dest>: gitignored env files do not come with a worktree
  local f copied=""
  for f in .env .env.local .env.dev .env.prod .env.development .env.production; do
    if [ -f "$1/$f" ] && [ ! -e "$2/$f" ]; then cp "$1/$f" "$2/$f"; copied="$copied $f"; fi
  done
  if [ -d "$1/.envs" ] && [ ! -e "$2/.envs" ]; then cp -R "$1/.envs" "$2/.envs"; copied="$copied .envs/"; fi
  [ -n "$copied" ] && note "copied env files (values not shown):$copied"
  return 0
}

point_urls_at_worktree() {  # rewrite the main stack's URLs in every env file of a worktree repo
  local dir="$1" f
  for f in .env .env.local .env.development; do
    [ -f "$dir/$f" ] || continue
    sed -i '' \
      -e "s#://localhost:8000#://localhost:$WEB_PORT#g" \
      -e "s#://127.0.0.1:8000#://localhost:$WEB_PORT#g" \
      -e "s#://localhost:3000#://$HOSTNAME_FE:$FE_PORT#g" \
      -e "s#://127.0.0.1:3000#://$HOSTNAME_FE:$FE_PORT#g" \
      "$dir/$f"
  done
}

resolve_ref() {  # resolve_ref <repo> <name>: origin/<name> if the remote has it, else a local ref, else empty
  local repo="$1" name="$2" candidate
  for candidate in "origin/${name#origin/}" "$name"; do
    git -C "$repo" rev-parse --verify --quiet "$candidate^{commit}" >/dev/null && { echo "$candidate"; return 0; }
  done
  return 0
}

add_worktree() {  # add_worktree <main checkout> <dest> <branch> <requested base> <default base>
  local repo="$1" dest="$2" branch="$3" base="$4" fallback="$5"
  if [ -e "$dest" ]; then note "$(basename "$dest"): already there"; return; fi
  git -C "$repo" fetch --quiet origin || note "fetch failed for $(basename "$repo") — using local refs"
  if [ "$base" != "$fallback" ]; then
    local resolved
    resolved="$(resolve_ref "$repo" "$base")"
    if [ -n "$resolved" ]; then
      base="$resolved"
    else
      note "!! $(basename "$repo") has no branch '$base' — cutting from $fallback instead"
      base="$fallback"
    fi
  fi
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add --quiet "$dest" "$branch"
    note "$(basename "$dest"): $branch already existed — reused it, base ignored"
  elif git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git -C "$repo" worktree add --quiet --track -b "$branch" "$dest" "origin/$branch"
    note "$(basename "$dest"): $branch exists on origin — tracking it, base ignored"
  else
    git -C "$repo" worktree add --quiet --no-track -b "$branch" "$dest" "$base"
    note "$(basename "$dest"): $branch cut from $base ($(git -C "$dest" rev-parse --short HEAD))"
  fi
}

dc() { local dir="$1"; shift; (cd "$dir" && docker compose "$@"); }

# Start the stack with a bare `up -d`: naming `web` brings only web and what it depends on, and
# nothing depends on the workers or Beat. Restart all of these together — the workers do not
# reload on code changes, so restarting web alone leaves them running the old code.
DJANGO_SERVICES="web worker-normal worker-medium worker-heavy beat"

wait_for_pg() {
  local _
  for _ in $(seq 1 90); do
    dc "$1" exec -T postgres pg_isready -h 127.0.0.1 -U admin -d grubbs_db >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "Postgres in $1 did not become ready"
}

table_count() {
  dc "$1" exec -T postgres psql -U admin -d grubbs_db -tAc \
    "select count(*) from information_schema.tables where table_schema='public'" | tr -d '[:space:]'
}

write_stack_config() {  # write_stack_config <backend dir> <override file> <project> <reset-all-ports: 0|1>
  local dir="$1" override="$2" project="$3" all="$4"
  mkdir -p "$(dirname "$override")"
  {
    echo "# Generated by grubbs-worktree.sh. Redis stays inside Docker: docker exec $project-redis-1 redis-cli"
    echo "services:"
    if [ "$all" -eq 1 ]; then
      echo "  web:"; echo "    ports: !reset []"
      echo "  postgres:"; echo "    ports: !reset []"
    fi
    echo "  redis:"; echo "    ports: !reset []"
  } > "$override"
  # Compose reads COMPOSE_FILE and interpolation vars from the project's .env, so plain
  # `docker compose ps|logs|run` from this directory targets this stack and nothing else.
  set_env "$dir/.env" COMPOSE_FILE "dev-compose.worktree.yml:$override"
  set_env "$dir/.env" CRM_WT_PROJECT "$project"
  set_env "$dir/.env" CRM_WT_IMAGE "$IMAGE"
  if [ "$all" -eq 0 ]; then
    set_env "$dir/.env" CRM_WT_WEB_PORT "$WEB_PORT"
    set_env "$dir/.env" CRM_WT_PG_PORT "$PG_PORT"
  fi
}

# ---------------------------------------------------------------------------------------------
# Snapshot

snapshot_key() {
  git -C "$BACKEND" ls-tree -r origin/dev -- crm_backend | grep '/migrations/' | shasum | cut -c1-12
}

ensure_snapshot() {  # sets SNAPSHOT to a dump matching origin/dev's migrations, building it if needed
  local refresh="$1" key src project cid log
  git -C "$BACKEND" fetch --quiet origin dev || note "fetch failed — using local origin/dev"
  key="$(snapshot_key)"
  SNAPSHOT="$SNAP_DIR/dev-$key.dump"
  if [ -f "$SNAPSHOT" ] && [ "$refresh" -eq 0 ]; then note "database snapshot: $(basename "$SNAPSHOT") (current)"; return; fi

  say "building the database snapshot from origin/dev — slow, once per migration change"
  mkdir -p "$SNAP_DIR"
  src="$SNAP_DIR/src"; project="grubbs-snapshot"; log="$SNAP_DIR/build.log"
  [ -e "$src" ] && { dc "$src" down -v >/dev/null 2>&1 || true; git -C "$BACKEND" worktree remove --force "$src" 2>/dev/null || rm -rf "$src"; }
  git -C "$BACKEND" worktree add --quiet --detach "$src" origin/dev
  copy_env_files "$BACKEND" "$src" >/dev/null
  write_stack_config "$src" "$SNAP_DIR/compose.override.yml" "$project" 1
  note "log: $log"

  local status=0
  (
    set -e
    dc "$src" up -d postgres redis
    wait_for_pg "$src"
    dc "$src" run --rm -T web bash -c "set -e; python manage.py migrate --noinput; $(echo "$SEEDS" | paste -sd ';' -)"
    cid="$(dc "$src" ps -q postgres)"
    docker exec "$cid" pg_dump -U admin -Fc -f /tmp/snapshot.dump grubbs_db
    docker cp "$cid:/tmp/snapshot.dump" "$SNAPSHOT.tmp"
  ) 2>&1 | tee "$log" || status=$?

  dc "$src" down -v >/dev/null 2>&1 || true
  git -C "$BACKEND" worktree remove --force "$src" 2>/dev/null || true
  [ "$status" -eq 0 ] && [ -s "$SNAPSHOT.tmp" ] || { rm -f "$SNAPSHOT.tmp"; die "snapshot build failed — see $log"; }
  mv "$SNAPSHOT.tmp" "$SNAPSHOT"
  find "$SNAP_DIR" -maxdepth 1 -name 'dev-*.dump' ! -name "$(basename "$SNAPSHOT")" -delete
  note "snapshot ready: $(basename "$SNAPSHOT") ($(du -h "$SNAPSHOT" | cut -f1))"
}

restore_snapshot() {  # restore_snapshot <backend dir>: only into an empty database
  local dir="$1" cid tables
  tables="$(table_count "$dir")"
  if [ "${tables:-0}" -gt 0 ]; then note "database already has $tables tables — not restoring"; return; fi
  cid="$(dc "$dir" ps -q postgres)"
  docker cp "$SNAPSHOT" "$cid:/tmp/snapshot.dump"
  # pg_restore exits non-zero on harmless notices (e.g. the public schema already existing),
  # so judge the result by what landed rather than by the exit code.
  docker exec "$cid" pg_restore -U admin -d grubbs_db --no-owner --no-privileges -j 4 /tmp/snapshot.dump >/dev/null 2>&1 || true
  docker exec "$cid" rm -f /tmp/snapshot.dump
  tables="$(table_count "$dir")"
  [ "${tables:-0}" -gt 0 ] || die "snapshot restore left the database empty"
  note "restored $tables tables from $(basename "$SNAPSHOT")"
}

# ---------------------------------------------------------------------------------------------
# Claude setup inside grubbs-<ticket>

link_claude() {
  local wt="$1" e name
  [ -e "$ROOT/CLAUDE.md" ] && ln -sfn "$ROOT/CLAUDE.md" "$wt/CLAUDE.md"
  [ -e "$ROOT/.mcp.json" ] && ln -sfn "$ROOT/.mcp.json" "$wt/.mcp.json"
  mkdir -p "$wt/.claude"
  for e in "$ROOT"/.claude/*; do
    name="$(basename "$e")"
    case "$name" in workspace.json|launch.json|__pycache__) continue ;; esac
    [ -e "$wt/.claude/$name" ] || ln -s "$e" "$wt/.claude/$name"
  done
  python3 - "$wt" "$(basename "$WT_BACKEND")" "$(basename "$WT_FRONTEND")" <<'PY'
import json, subprocess, sys, time
wt, backend, frontend = sys.argv[1:4]
def info(rel):
    g = lambda *a: subprocess.run(["git", "-C", f"{wt}/{rel}", *a], capture_output=True, text=True).stdout.strip()
    return {"path": rel, "remote": g("remote", "get-url", "origin"), "branch": g("branch", "--show-current")}
data = {"workspace": wt, "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "repos": {"backend": info(backend), "frontend": info(frontend)}}
json.dump(data, open(f"{wt}/.claude/workspace.json", "w"), indent=2)
PY
  cat > "$wt/.claude/launch.json" <<EOF
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "grubbs-$TICKET",
      "runtimeExecutable": "/bin/zsh",
      "runtimeArgs": ["-c", "cd $WT_FRONTEND && exec $NODE20/node node_modules/next/dist/bin/next dev --turbopack --port $FE_PORT"],
      "port": $FE_PORT
    }
  ]
}
EOF
}

# ---------------------------------------------------------------------------------------------
# Frontend process

frontend_up() { port_busy "$FE_PORT"; }

pnpm_install() {
  # Install with the pnpm major the lockfile was written by. The frontend's lockfile is still v6
  # (pnpm 8); a newer pnpm silently rewrites it to v9 and the worktree starts life dirty. corepack
  # fetches that major into its own cache — nothing is installed globally.
  local dir="$1" pnpm_cmd="pnpm"
  if head -1 "$dir/pnpm-lock.yaml" 2>/dev/null | grep -q "'6\."; then pnpm_cmd="corepack pnpm@8"; fi
  note "$pnpm_cmd install --frozen-lockfile"
  # shellcheck disable=SC2086  # pnpm_cmd is deliberately word-split
  (cd "$dir" && PATH="$NODE20:$PATH" CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    $pnpm_cmd install --frozen-lockfile --prefer-offline)
}

stop_frontend() {
  local pidfile="$WT/.worktree/frontend.pid" pid
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  # next dev forks workers that outlive the pnpm parent; whatever still holds the port goes too
  lsof -tiTCP:"$FE_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}

start_frontend() {  # detached next dev on FE_PORT, logged to .worktree/logs; needs NODE20 and WT_FRONTEND
  mkdir -p "$WT/.worktree/logs"
  (cd "$WT_FRONTEND" && PATH="$NODE20:$PATH" nohup node node_modules/next/dist/bin/next dev --turbopack --port "$FE_PORT" \
    > "$WT/.worktree/logs/frontend.log" 2>&1 & echo $! > "$WT/.worktree/frontend.pid")
}

wait_for_frontend() {  # after start_frontend: return once FE_PORT listens; die if next dev exits or 90s pass
  local pid _
  pid="$(cat "$WT/.worktree/frontend.pid")"
  for _ in $(seq 1 45); do
    frontend_up && { note "listening on :$FE_PORT (pid $pid, log .worktree/logs/frontend.log)"; return; }
    kill -0 "$pid" 2>/dev/null || { tail -n 20 "$WT/.worktree/logs/frontend.log" >&2; die "next dev exited before listening on :$FE_PORT"; }
    sleep 2
  done
  die "not listening on :$FE_PORT after 90s — tail -f $WT/.worktree/logs/frontend.log"
}

wait_for_api() {  # wait_for_api <tries>: any HTTP status counts, 4s apart
  local code=000 _
  for _ in $(seq 1 "$1"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$API_URL/" || true)"
    [ "$code" != "000" ] && return 0
    sleep 4
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# T3 Code

t3_connect() {  # t3_connect <hint>: sets T3_ORIGIN and T3_TOKEN; 2 = not installed or not open (noted), 1 = error
  local runtime="$T3_HOME/userdata/server-runtime.json" tokfile
  [ -d "$T3_APP" ] && [ -f "$runtime" ] || { note "T3 Code not installed — skipped"; return 2; }
  T3_ORIGIN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["origin"])' "$runtime")" || return 1
  curl -s -o /dev/null --max-time 3 "$T3_ORIGIN/.well-known/t3/environment" \
    || { note "T3 Code is not open — $1"; return 2; }

  # A fresh 5-minute token from T3's own CLI, so nothing long-lived is stored. It goes through a
  # file because the Electron binary drops stdout written to a pipe.
  tokfile="$(mktemp)"
  ELECTRON_RUN_AS_NODE=1 "$T3_APP/Contents/MacOS/$(basename "$T3_APP" .app)" \
    "$T3_APP/Contents/Resources/app.asar/apps/server/dist/bin.mjs" \
    auth session issue --token-only --ttl 5m --label grubbs-worktree > "$tokfile" 2>/dev/null || { rm -f "$tokfile"; return 1; }
  T3_TOKEN="$(tr -d '[:space:]' < "$tokfile")"; rm -f "$tokfile"
  [ -n "$T3_TOKEN" ]
}

t3_add_project() {  # add $WT to T3 Code with Frontend and Backend buttons; safe to run twice
  local rc=0
  t3_connect "open it, then run: launch-worktree $TICKET --no-start" || rc=$?
  [ "$rc" -eq 2 ] && return 0
  [ "$rc" -eq 0 ] || return 1

  T3_TOKEN="$T3_TOKEN" python3 - "$T3_ORIGIN" "$WT" "$T3_HOME/userdata/settings.json" "$SELF" "$TICKET" "$FE_PORT" "$WEB_PORT" "$FE_URL" <<'PY'
import json, os, shlex, sys, uuid, urllib.request
origin, wt, settings_path, self_path, ticket, fe_port, web_port, fe_url = sys.argv[1:9]

def call(method, path, body=None):
    req = urllib.request.Request(
        origin + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ['T3_TOKEN']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

title = os.path.basename(wt)
# T3 server 0.1.3 moved projects off /api/orchestration/{shell,dispatch} to /api/projects{,/mutate}.
existing = [p for p in call("GET", "/api/projects")["projects"]
            if p.get("deletedAt") is None and os.path.realpath(p["workspaceRoot"]) == os.path.realpath(wt)]
if existing:
    project_id, how = existing[0]["id"], "already in T3 Code"
else:
    project_id, how = str(uuid.uuid4()), "added to T3 Code"
    call("POST", "/api/projects/mutate", {
        "type": "project.create", "commandId": str(uuid.uuid4()), "projectId": project_id,
        "title": title, "workspaceRoot": wt})

run = lambda sub: f"{shlex.quote(self_path)} {sub} {ticket}"
scripts = [
    {"id": "frontend", "name": f"Frontend :{fe_port}", "command": run("frontend"), "icon": "play",
     "runOnWorktreeCreate": False, "previewUrl": fe_url, "autoOpenPreview": True},
    {"id": "backend", "name": f"Backend :{web_port}", "command": run("backend"), "icon": "build",
     "runOnWorktreeCreate": False},
]
# Buttons live per project in T3's settings.json, which T3 watches and reloads on change.
# Written atomically next to the original so T3 never reads half a file.
settings = json.load(open(settings_path)) if os.path.exists(settings_path) else {}
settings.setdefault("projectSettingsOverrides", {}).setdefault(project_id, {})["defaultProjectScripts"] = scripts
tmp = f"{settings_path}.launch-worktree.tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.replace(tmp, settings_path)
print(f"    {title}: {how}, buttons Frontend :{fe_port} and Backend :{web_port}")
PY
}

t3_remove_project() {  # remove $WT's project, its chats and its buttons from T3 Code; safe to run twice
  local rc=0
  t3_connect "remove grubbs-$TICKET from its sidebar by hand" || rc=$?
  [ "$rc" -eq 2 ] && return 0
  [ "$rc" -eq 0 ] || return 1

  T3_TOKEN="$T3_TOKEN" python3 - "$T3_ORIGIN" "$WT" "$T3_HOME/userdata/settings.json" <<'PY'
import json, os, sys, uuid, urllib.request
origin, wt, settings_path = sys.argv[1:4]

def call(method, path, body=None):
    req = urllib.request.Request(
        origin + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ['T3_TOKEN']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

# The folder may already be gone, so compare plain paths rather than resolved ones.
ids = [p["id"] for p in call("GET", "/api/projects")["projects"]
       if p.get("deletedAt") is None and os.path.normpath(p["workspaceRoot"]) == os.path.normpath(wt)]
# force: T3 refuses to delete a project that still has chats; they point at a deleted folder.
for project_id in ids:
    call("POST", "/api/projects/mutate", {
        "type": "project.delete", "commandId": str(uuid.uuid4()), "projectId": project_id, "force": True})

if ids and os.path.exists(settings_path):
    settings = json.load(open(settings_path))
    overrides = settings.get("projectSettingsOverrides", {})
    if [i for i in ids if overrides.pop(i, None) is not None]:
        tmp = f"{settings_path}.remove-worktree.tmp"
        with open(tmp, "w") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        os.replace(tmp, settings_path)

print(f"    {os.path.basename(wt)}: {'removed from' if ids else 'was not in'} T3 Code")
PY
}

# ---------------------------------------------------------------------------------------------
# Commands

load_worktree() {  # sets WT and the .worktree.env values for a ticket
  TICKET="$(ticket_of "${1:-}")"
  WT="$WT_HOME/grubbs-$TICKET"
  BRANCH="$PREFIX/$TICKET"
  HOSTNAME_FE="grubbs-$TICKET.localhost"
  if [ -f "$WT/.worktree.env" ]; then
    # shellcheck disable=SC1091
    . "$WT/.worktree.env"
  fi
}

cmd_launch() {
  local refresh=0 start=1 ticket="" base="" backend_base="" frontend_base=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --refresh-snapshot) refresh=1 ;;
      --no-start) start=0 ;;
      --base|--backend-base|--frontend-base)
        [ $# -ge 2 ] || die "$1 needs a branch name"
        case "$1" in --base) base="$2" ;; --backend-base) backend_base="$2" ;; *) frontend_base="$2" ;; esac
        shift ;;
      --base=*) base="${1#*=}" ;;
      --backend-base=*) backend_base="${1#*=}" ;;
      --frontend-base=*) frontend_base="${1#*=}" ;;
      -*) die "unknown option $1" ;;
      *) ticket="$1" ;;
    esac
    shift
  done
  backend_base="${backend_base:-${base:-origin/dev}}"
  frontend_base="${frontend_base:-${base:-origin/dev}}"
  load_worktree "$ticket"
  [ "$start" -eq 0 ] || docker info >/dev/null 2>&1 || die "Docker is not running"

  BACKEND="$(repo_path backend)"; FRONTEND="$(repo_path frontend)"; PLAYBOOK="$ROOT/engineering-playbook"
  [ -n "$BACKEND" ] && [ -n "$FRONTEND" ] || die "backend or frontend not found in .claude/workspace.json"
  [ -e "$PLAYBOOK/.git" ] || die "$PLAYBOOK is not a git checkout"
  NODE20="$(node20_bin)"
  WT_BACKEND="$WT/$(basename "$BACKEND")"; WT_FRONTEND="$WT/$(basename "$FRONTEND")"
  local wt_playbook fresh_env=0
  wt_playbook="$WT/$(basename "$PLAYBOOK")"

  # A typo in --base should stop everything, not quietly fall back to dev in both repos.
  if [ -n "$base" ] && [ ! -e "$WT_BACKEND" ] && [ ! -e "$WT_FRONTEND" ]; then
    git -C "$BACKEND" fetch --quiet origin || true
    git -C "$FRONTEND" fetch --quiet origin || true
    [ -n "$(resolve_ref "$BACKEND" "$base")$(resolve_ref "$FRONTEND" "$base")" ] \
      || die "no branch '$base' in crm-backend or crm-frontend (checked origin and local)"
  fi

  say "grubbs-$TICKET → $WT"
  mkdir -p "$WT/.worktree/logs"
  if [ -z "${WEB_PORT:-}" ]; then
    pick_ports
    cat > "$WT/.worktree.env" <<EOF
TICKET=$TICKET
BRANCH=$BRANCH
PROJECT=grubbs-$TICKET
WEB_PORT=$WEB_PORT
PG_PORT=$PG_PORT
FE_PORT=$FE_PORT
FE_URL=http://$HOSTNAME_FE:$FE_PORT
API_URL=http://localhost:$WEB_PORT
EOF
    # shellcheck disable=SC1091  # FE_URL / API_URL exist only in the file until it is sourced
    . "$WT/.worktree.env"
  fi
  note "ports: frontend $FE_PORT, backend $WEB_PORT, postgres $PG_PORT (redis stays inside Docker)"

  say "worktrees on $BRANCH"
  add_worktree "$BACKEND" "$WT_BACKEND" "$BRANCH" "$backend_base" origin/dev
  add_worktree "$FRONTEND" "$WT_FRONTEND" "$BRANCH" "$frontend_base" origin/dev
  add_worktree "$PLAYBOOK" "$wt_playbook" "$BRANCH" origin/main origin/main

  say "env files"
  [ -e "$WT_BACKEND/.env" ] || fresh_env=1
  copy_env_files "$BACKEND" "$WT_BACKEND"
  copy_env_files "$FRONTEND" "$WT_FRONTEND"
  if [ "$fresh_env" -eq 1 ]; then
    point_urls_at_worktree "$WT_BACKEND"
    point_urls_at_worktree "$WT_FRONTEND"
    note "URLs now point at http://$HOSTNAME_FE:$FE_PORT and http://localhost:$WEB_PORT"
  fi

  say "Claude setup"
  link_claude "$WT"
  note "CLAUDE.md and .claude/ linked; own workspace.json and launch.json (grubbs-$TICKET)"

  say "T3 Code"
  t3_add_project || note "could not add grubbs-$TICKET to T3 Code — the worktree itself is fine"

  if [ "$start" -eq 0 ]; then
    printf '\n==> grubbs-%s is ready, nothing started — run launch-worktree %s to start it\n' "$TICKET" "$TICKET"
    return
  fi

  IMAGE="$(web_image)"
  ensure_snapshot "$refresh"

  say "backend stack grubbs-$TICKET"
  write_stack_config "$WT_BACKEND" "$WT/.worktree/compose.override.yml" "grubbs-$TICKET" 0
  dc "$WT_BACKEND" up -d postgres redis
  wait_for_pg "$WT_BACKEND"
  restore_snapshot "$WT_BACKEND"
  dc "$WT_BACKEND" up -d
  note "web runs this branch's own migrations, then uvicorn; the three Celery workers and Beat start with it"
  wait_for_api 150 || die "backend did not answer on :$WEB_PORT — cd $WT_BACKEND && docker compose logs web"
  note "backend answering on http://localhost:$WEB_PORT"

  say "frontend"
  if [ ! -d "$WT_FRONTEND/node_modules" ]; then
    pnpm_install "$WT_FRONTEND"
  fi
  if frontend_up; then
    note "already running on :$FE_PORT"
  else
    start_frontend
    for _ in $(seq 1 45); do frontend_up && break; sleep 2; done
    if frontend_up; then note "started on :$FE_PORT"; else note "not listening yet — tail -f $WT/.worktree/logs/frontend.log"; fi
  fi

  cat <<EOF

==> grubbs-$TICKET is up

  App        http://$HOSTNAME_FE:$FE_PORT      (log: .worktree/logs/frontend.log)
  API        http://localhost:$WEB_PORT
  Postgres   localhost:$PG_PORT  admin/admin  grubbs_db
  Logins     $FRONTEND/.claude/local-credentials.md
  Backend    cd $WT_BACKEND && docker compose logs -f web      (compose targets this stack only)
  Claude     cd $WT && claude

  Remove with: remove-worktree $TICKET
EOF
}

load_repos() {  # load_repos <ticket>: worktree values plus WT_BACKEND / WT_FRONTEND
  load_worktree "${1:-}"
  [ -n "${FE_PORT:-}" ] || die "$WT/.worktree.env not found — run launch-worktree $TICKET first"
  BACKEND="$(repo_path backend)"; FRONTEND="$(repo_path frontend)"
  WT_BACKEND="$WT/$(basename "$BACKEND")"; WT_FRONTEND="$WT/$(basename "$FRONTEND")"
}

cmd_frontend() {  # the T3 "Frontend" button: stop whatever serves FE_PORT, run next dev here
  load_repos "${1:-}"
  NODE20="$(node20_bin)"
  stop_frontend
  for _ in $(seq 1 10); do port_busy "$FE_PORT" || break; sleep 1; done
  say "grubbs-$TICKET frontend → $FE_URL"
  cd "$WT_FRONTEND"
  PATH="$NODE20:$PATH" exec node node_modules/next/dist/bin/next dev --turbopack --port "$FE_PORT"
}

cmd_backend() {  # the T3 "Backend" button: start the stack, restart web + Celery, follow its log
  load_repos "${1:-}"
  docker info >/dev/null 2>&1 || die "Docker is not running"
  dc "$WT_BACKEND" up -d
  dc "$WT_BACKEND" restart $DJANGO_SERVICES
  say "grubbs-$TICKET backend → $API_URL (Ctrl-C stops the log, not the server)"
  cd "$WT_BACKEND"
  exec docker compose logs -f --tail 50 web
}

cmd_restart_frontend() {  # cmd_frontend for apps: next dev detached, exit 0 once it listens
  load_repos "${1:-}"
  NODE20="$(node20_bin)"
  [ -d "$WT_FRONTEND/node_modules" ] || pnpm_install "$WT_FRONTEND"
  say "grubbs-$TICKET frontend → $FE_URL"
  stop_frontend
  for _ in $(seq 1 10); do port_busy "$FE_PORT" || break; sleep 1; done
  ! port_busy "$FE_PORT" || die "port $FE_PORT is still taken after stopping the frontend"
  start_frontend
  wait_for_frontend
}

launch_if_never_started() {  # a --no-start worktree has no stack yet: launch sets it up, database included
  grep -q '^CRM_WT_PROJECT=' "$WT_BACKEND/.env" 2>/dev/null && return 0
  say "grubbs-$TICKET was launched with --no-start, so its stack does not exist yet: launching it"
  exec "$SELF" launch "$TICKET"
}

cmd_restart_backend() {  # cmd_backend for apps: no log follow, exit 0 once the API answers
  load_repos "${1:-}"
  docker info >/dev/null 2>&1 || die "Docker is not running"
  launch_if_never_started
  say "grubbs-$TICKET backend → $API_URL"
  dc "$WT_BACKEND" up -d
  dc "$WT_BACKEND" restart $DJANGO_SERVICES
  wait_for_api 75 || die "backend did not answer on $API_URL within 5 minutes — cd $WT_BACKEND && docker compose logs web"
  note "answering on $API_URL"
}

cmd_start() {  # for apps: bring up what is down, leave what runs alone; exit 0 once both answer
  load_repos "${1:-}"
  docker info >/dev/null 2>&1 || die "Docker is not running"
  launch_if_never_started
  NODE20="$(node20_bin)"
  say "grubbs-$TICKET backend → $API_URL"
  dc "$WT_BACKEND" up -d
  wait_for_api 75 || die "backend did not answer on $API_URL within 5 minutes — cd $WT_BACKEND && docker compose logs web"
  note "answering on $API_URL"
  say "grubbs-$TICKET frontend → $FE_URL"
  if frontend_up; then note "already running on :$FE_PORT"; return; fi
  [ -d "$WT_FRONTEND/node_modules" ] || pnpm_install "$WT_FRONTEND"
  start_frontend
  wait_for_frontend
}

cmd_stop() {  # cmd_stop <ticket> [frontend|backend]: ports stay reserved, the database volume stays
  load_repos "${1:-}"
  local which="${2:-both}"
  case "$which" in both|frontend|backend) ;; *) die "stop takes frontend or backend, got '$which'" ;; esac
  if [ "$which" != backend ]; then
    say "grubbs-$TICKET frontend"
    stop_frontend
    for _ in $(seq 1 10); do port_busy "$FE_PORT" || break; sleep 1; done
    ! port_busy "$FE_PORT" || die "port $FE_PORT is still taken after stopping the frontend"
    note "stopped, :$FE_PORT is free"
  fi
  if [ "$which" != frontend ]; then
    docker info >/dev/null 2>&1 || die "Docker is not running"
    say "grubbs-$TICKET backend stack"
    dc "$WT_BACKEND" stop
    note "stopped, the database volume is kept"
  fi
}

cmd_next_ports() {  # what pick_ports would give a new worktree right now; nothing is reserved
  pick_ports
  printf '{"fePort":%s,"webPort":%s,"pgPort":%s}\n' "$FE_PORT" "$WEB_PORT" "$PG_PORT"
}

cmd_logs() {  # cmd_logs <ticket> frontend|backend [lines]: a tail, never a follow
  load_repos "${1:-}"
  local lines="${3:-200}"
  case "$lines" in ''|*[!0-9]*) die "lines must be a number, got '$lines'" ;; esac
  case "${2:-}" in
    frontend)
      [ -f "$WT/.worktree/logs/frontend.log" ] || die "no frontend log yet in $WT/.worktree/logs"
      tail -n "$lines" "$WT/.worktree/logs/frontend.log" ;;
    backend)
      docker info >/dev/null 2>&1 || die "Docker is not running"
      dc "$WT_BACKEND" logs --no-color --tail "$lines" web ;;
    *) die "logs needs frontend or backend" ;;
  esac
}

json_str() {  # a JSON string, or null when empty; values here are paths, URLs and branch names
  if [ -z "$1" ]; then printf 'null'; return; fi
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

json_num() { case "$1" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

ls_one() {  # ls_one <dir/> <json: 0|1> <git: 0|1>; runs in a subshell, it sources .worktree.env
  local d="$1" json="$2" git="$3" running fe r dirty sep=""
  # shellcheck disable=SC1090,SC1091
  . "$d.worktree.env"
  # Docker down means 0 containers, not a failed listing.
  running="$( { docker ps --filter "label=com.docker.compose.project=${PROJECT:?}" -q 2>/dev/null || true; } | wc -l | tr -d ' ')"
  port_busy "$FE_PORT" && fe=up || fe=down
  if [ "$json" -eq 0 ]; then
    printf '%s  %s\n' "$PROJECT" "$BRANCH"
    printf '    app  %-38s %s\n' "$FE_URL" "$fe"
    printf '    api  %-38s %s/3 containers\n' "$API_URL" "$running"
    printf '    pg   localhost:%s\n' "$PG_PORT"
  else
    printf '{"ticket":%s,"path":%s,"branch":%s,"project":%s,"feUrl":%s,"apiUrl":%s,"fePort":%s,"webPort":%s,"pgPort":%s,"frontendUp":%s,"containersRunning":%s,"repos":[' \
      "$(json_str "$TICKET")" "$(json_str "${d%/}")" "$(json_str "$BRANCH")" "$(json_str "$PROJECT")" "$(json_str "$FE_URL")" "$(json_str "$API_URL")" \
      "$(json_num "$FE_PORT")" "$(json_num "$WEB_PORT")" "$(json_num "$PG_PORT")" \
      "$([ "$fe" = up ] && echo true || echo false)" "$(json_num "$running")"
  fi
  for r in "$d"*/; do
    [ -e "$r.git" ] || continue
    dirty=null
    if [ "$git" -eq 1 ]; then
      [ -n "$(git -C "$r" status --porcelain)" ] && dirty=true || dirty=false
    fi
    if [ "$json" -eq 0 ]; then
      printf '    %-22s %s%s\n' "$(basename "$r")" "$(git -C "$r" branch --show-current)" \
        "$([ "$dirty" = true ] && echo '  (uncommitted changes)')"
    else
      printf '%s{"name":%s,"branch":%s,"dirty":%s}' "$sep" "$(json_str "$(basename "$r")")" \
        "$(json_str "$(git -C "$r" branch --show-current)")" "$dirty"
      sep=","
    fi
  done
  [ "$json" -eq 0 ] || printf ']}'
}

cmd_ls() {
  local d found=0 json=0 git=1 ticket="" arg pattern="grubbs-*"
  for arg in "$@"; do
    case "$arg" in --json) json=1 ;; --no-git) git=0 ;; -*) die "unknown option $arg" ;; *) ticket="$(ticket_of "$arg")" ;; esac
  done
  [ -z "$ticket" ] || pattern="grubbs-$ticket"
  [ "$json" -eq 0 ] || printf '['
  for d in "$WT_HOME"/$pattern/; do
    [ -f "$d.worktree.env" ] || continue
    [ "$json" -eq 0 ] || [ "$found" -eq 0 ] || printf ','
    found=1
    ( ls_one "$d" "$json" "$git" )
  done
  if [ "$json" -eq 1 ]; then printf ']\n'; elif [ "$found" -eq 0 ]; then echo "no worktrees in $WT_HOME"; fi
}

cmd_remove() {
  local force=0 delete_branches=0 arg ticket="" r main
  for arg in "$@"; do
    case "$arg" in --force) force=1 ;; --delete-branches) delete_branches=1 ;; *) ticket="$arg" ;; esac
  done
  load_worktree "$ticket"
  [ -d "$WT" ] || die "$WT does not exist"

  if [ "$force" -eq 0 ]; then
    for r in "$WT"/*/; do
      [ -e "$r.git" ] || continue
      [ -z "$(git -C "$r" status --porcelain)" ] || die "$(basename "$r") has uncommitted changes — commit them or pass --force"
    done
  fi

  say "stopping grubbs-$TICKET"
  [ -n "${FE_PORT:-}" ] && stop_frontend
  for r in "$WT"/*/; do
    [ -f "$r/dev-compose.worktree.yml" ] && [ -f "$r/.env" ] && { dc "$r" down -v || true; }
  done

  say "removing worktrees"
  for r in "$WT"/*/; do
    [ -e "$r.git" ] || continue
    main="$(git -C "$r" rev-parse --path-format=absolute --git-common-dir)"
    main="$(dirname "$main")"
    if [ "$force" -eq 1 ]; then git -C "$main" worktree remove --force "${r%/}"; else git -C "$main" worktree remove "${r%/}"; fi
    note "$(basename "$r") removed"
    if [ "$delete_branches" -eq 1 ]; then
      if [ "$force" -eq 1 ]; then git -C "$main" branch -D "$BRANCH"; else git -C "$main" branch -d "$BRANCH" || note "kept $BRANCH in $(basename "$main") (not merged — --force deletes it)"; fi
    fi
  done

  case "$WT" in "$WT_HOME"/grubbs-*) rm -rf "$WT" ;; esac
  note "grubbs-$TICKET gone"

  # Last, because running this from a T3 terminal in the project can close that terminal.
  say "T3 Code"
  t3_remove_project || note "could not remove grubbs-$TICKET from T3 Code — remove it from the sidebar by hand"
}

cmd_install() {
  local name
  mkdir -p "$BIN_DIR"
  for name in launch-worktree remove-worktree worktree-ls; do
    ln -sfn "$SELF" "$BIN_DIR/$name"
    note "$BIN_DIR/$name → $SELF"
  done
}

case "$(basename "$0")" in
  launch-worktree) cmd_launch "$@" ;;
  remove-worktree) cmd_remove "$@" ;;
  worktree-ls)     cmd_ls "$@" ;;
  *)
    sub="${1:-}"; shift || true
    case "$sub" in
      launch)  cmd_launch "$@" ;;
      remove)  cmd_remove "$@" ;;
      ls)      cmd_ls "$@" ;;
      install) cmd_install ;;
      frontend) cmd_frontend "$@" ;;
      backend) cmd_backend "$@" ;;
      restart-frontend) cmd_restart_frontend "$@" ;;
      restart-backend)  cmd_restart_backend "$@" ;;
      logs)    cmd_logs "$@" ;;
      start)   cmd_start "$@" ;;
      stop)    cmd_stop "$@" ;;
      next-ports) cmd_next_ports ;;
      *) sed -n '2,33p' "$SELF" | sed 's/^# \{0,1\}//'; exit 1 ;;
    esac
    ;;
esac
