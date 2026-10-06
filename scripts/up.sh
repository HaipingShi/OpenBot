#!/bin/bash
# One-command bring-up for THIS machine (Windows / Git Bash). The counterpart to down.sh.
#
# What it does, in order, skipping anything already running:
#   1. Docker Desktop (E:\Docker\DockerDesktop — not the default install path) and its engine
#   2. The compose stack (postgres, agent-computer, agent-bot, langgraph, supervisor, spire)
#   3. The three host processes: API server (3001), worker, app (3010)
#   4. Health checks, then the idempotent steel-directory setup (15 tools, grants, policy)
#
# Usage:  bun run up        (or bash scripts/up.sh)

set -u
cd "$(dirname "$0")/.."
# Absolute: the host processes are started from inside their own workspace (cd server && ...), so
# a relative log path would land in server/.logs and the redirection would fail the start quietly.
LOGS="$(pwd)/.logs"
mkdir -p "$LOGS"

DOCKER_DESKTOP_EXE="${DOCKER_DESKTOP_EXE:-E:\\Docker\\DockerDesktop\\Docker Desktop.exe}"
# PowerShell needs backslashes doubled through bash; build the command carefully.
DOCKER_DESKTOP_PS='E:\Docker\DockerDesktop\Docker Desktop.exe'

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  !    %s\n' "$*"; }
die()  { printf '  FAIL %s\n' "$*"; exit 1; }

# ---------------------------------------------------------------- 1. docker engine
if docker info >/dev/null 2>&1; then
  ok "docker engine is running"
else
  say "starting Docker Desktop ($DOCKER_DESKTOP_PS)..."
  powershell -NoProfile -Command "Start-Process '$DOCKER_DESKTOP_PS'" || die "could not launch Docker Desktop"
  waited=0
  until docker info >/dev/null 2>&1; do
    waited=$((waited + 5))
    [ "$waited" -ge 180 ] && die "docker engine did not come up within 180s (is Docker Desktop installed at E:\\Docker\\DockerDesktop?)"
    sleep 5
  done
  ok "docker engine ready after ${waited}s"
fi

# ---------------------------------------------------------------- 2. containers
say "bringing up the compose stack..."
docker compose up -d >/dev/null 2>&1 || die "docker compose up failed (see: docker compose up -d)"
docker compose ps --format '{{.Service}} {{.Status}}' | grep -q Healthy || sleep 10
ok "containers up ($(docker compose ps --quiet | wc -l | tr -d ' ') running)"

# ---------------------------------------------------------------- 3. host processes
# Is this thing already answering? A port check is the honest test — process lists lie about
# half-started things.
port_up() { curl -s -o /dev/null -m 2 "$1"; }

start_bg() { # start_bg <logfile> <cmd...>
  local log="$LOGS/$1"; shift
  ( nohup "$@" >"$log" 2>&1 & )
}

# The worker has no port; ask Windows which bun processes exist and match its command line. The
# worker is started from inside `worker/`, so its command line says `src/index.ts` — the server's
# says `src/production-entry.ts`, so this pattern only ever matches the worker.
worker_running() {
  powershell -NoProfile -Command \
    "if (Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \$_.CommandLine -like '*src/index.ts*' }) { exit 0 } else { exit 1 }" \
    >/dev/null 2>&1
}

if port_up http://localhost:3001/api/capabilities; then
  ok "API server already answering on 3001"
else
  say "starting API server..."
  ( cd server && start_bg server.log bun --env-file=../.env src/production-entry.ts )
  waited=0
  until port_up http://localhost:3001/api/capabilities; do
    waited=$((waited + 2))
    [ "$waited" -ge 90 ] && die "API server did not answer within 90s — see $LOGS/server.log"
    sleep 2
  done
  ok "API server on 3001 (after ${waited}s)"
fi

if worker_running; then
  ok "worker already running"
else
  ( cd worker && start_bg worker.log bun --env-file=../.env src/index.ts )
  sleep 2
  worker_running && ok "worker started" || warn "worker may not have started — see $LOGS/worker.log"
fi

if port_up http://localhost:3010/; then
  ok "app already answering on 3010"
else
  say "starting app..."
  ( cd app && start_bg app.log bun run dev --port 3010 --strictPort )
  waited=0
  until port_up http://localhost:3010/; do
    waited=$((waited + 2))
    [ "$waited" -ge 60 ] && die "app did not answer within 60s — see $LOGS/app.log"
    sleep 2
  done
  ok "app on 3010 (after ${waited}s)"
fi

# ---------------------------------------------------------------- 4. steel-directory setup
# Idempotent: registers the capability, 29 grants, 5 handoffs, merges the policy rule. Cheap, and
# the one step a fresh clone forgets.
if bun --env-file=.env scripts/steel-directory-setup.ts >/dev/null 2>&1; then
  ok "steel-directory setup applied (15 tools, grants, policy)"
else
  warn "steel-directory setup failed — run: bun run steel:setup"
fi

# ---------------------------------------------------------------- 5. summary
licence=$(curl -s -m 5 http://localhost:3001/api/copilotkit/info | sed -n 's/.*"licenseStatus":"\([a-z]*\)".*/\1/p')
agents=$(curl -s -m 5 http://localhost:3001/api/agents | grep -o '"id"' | wc -l | tr -d ' ')
say ""
say "Ready."
say "  app:      http://localhost:3010"
say "  api:      http://localhost:3001"
say "  licence:  ${licence:-unknown}(冷启动首查可能是 unknown,几秒后自愈)"
say "  agents:   $agents"
say "  logs:     $LOGS/"
say ""
say "停止: bun run down"
