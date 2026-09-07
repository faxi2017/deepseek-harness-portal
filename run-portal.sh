#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo 'Copy .env.example to .env and configure it first.' >&2; exit 1; }
sqlite_error=''
prebuild='portal/node_modules/better-sqlite3/prebuilds/linux-x64.node'
if ! sqlite_error="$(node -e "const Database=require('./portal/node_modules/better-sqlite3');new Database(':memory:').close()" 2>&1)"; then
  if [[ "$sqlite_error" != *"GLIBC_"*"not found"* ]] && [ ! -f "$prebuild.incompatible" ]; then
    printf '%s\n' "$sqlite_error" >&2
    exit 1
  fi
  echo 'Rebuilding better-sqlite3 for this Linux host...'
  [ ! -f "$prebuild" ] || mv -f "$prebuild" "$prebuild.incompatible"
  command -v g++-11 >/dev/null 2>&1 && export CXX=g++-11
  npm run build-release --prefix portal/node_modules/better-sqlite3
  node -e "const Database=require('./portal/node_modules/better-sqlite3');new Database(':memory:').close()"
fi
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
