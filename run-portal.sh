#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo 'Copy .env.example to .env and configure it first.' >&2; exit 1; }
pid_file="$PWD/.portal.pid"
if [ -s "$pid_file" ]; then
  saved_pid="$(cat "$pid_file")"
  if [[ "$saved_pid" =~ ^[0-9]+$ ]] && kill -0 "$saved_pid" 2>/dev/null; then
    echo "Portal is already running (PID $saved_pid)." >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > "$pid_file"
# Runtime preflight applies the Docker firewall before listening.
exec node --env-file=.env portal/src/index.js
