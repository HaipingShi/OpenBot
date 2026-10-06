#!/bin/bash
# One-command shutdown for THIS machine (Windows / Git Bash). The counterpart to up.sh.
#
# Stops the three host processes by their command line (never "all bun.exe" — that would take down
# anything else Bun-based you have open), then stops the containers. Volumes are kept, so the
# database, the directory data and every Bot's files survive.
#
# Usage:  bun run down          # stop processes + containers (data kept)
#         bun run down --keep   # stop host processes, leave containers running

set -u
cd "$(dirname "$0")/.."

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }

# Kill the processes whose command line matches, and say which. Matching on the command line is the
# whole point of doing this in PowerShell: a bare `taskkill //IM bun.exe` takes down every Bun
# process on the machine, including ones that have nothing to do with this repo.
kill_matching() { # kill_matching <label> <pattern>
  local label="$1" pattern="$2"
  local pids
  pids=$(powershell -NoProfile -Command \
    "(Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \$_.CommandLine -like '*$pattern*' }).ProcessId" \
    2>/dev/null | tr -d '\r')
  if [ -z "$pids" ]; then
    ok "$label: not running"
    return
  fi
  for pid in $pids; do
    powershell -NoProfile -Command "Stop-Process -Id $pid -Force" >/dev/null 2>&1
  done
  ok "$label: stopped ($(echo $pids | wc -w | tr -d ' ') process(es))"
}

kill_matching "app"     "vite.js --port 3010"
kill_matching "app (bun run dev)" "run dev --port 3010"
kill_matching "server"  "production-entry.ts"
# Two spellings on purpose: up.sh starts the worker from inside `worker/` (command line says
# `src/index.ts`), start.sh historically from the repo root (`worker/src/index.ts`).
kill_matching "worker"  "src/index.ts"
kill_matching "worker (start.sh style)" "worker/src/index.ts"

if [ "${1:-}" = "--keep" ]; then
  ok "containers: left running (--keep)"
else
  if docker compose down >/dev/null 2>&1; then
    ok "containers: stopped (volumes kept — data survives)"
  else
    ok "containers: docker engine not running, nothing to stop"
  fi
fi

say ""
say "Stopped. 再次拉起: bun run up"
