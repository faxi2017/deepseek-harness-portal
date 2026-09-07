#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
root="$PWD"
pid_file="$root/.portal.pid"

is_portal_pid() {
  local candidate="$1" cmd cwd
  [[ "$candidate" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$candidate" 2>/dev/null || return 1
  cwd="$(readlink -f "/proc/$candidate/cwd" 2>/dev/null || true)"
  cmd="$(tr '\0' ' ' < "/proc/$candidate/cmdline" 2>/dev/null || true)"
  [[ "$cwd" == "$root" && " $cmd " == *" portal/src/index.js "* ]]
}

portal_pid=""
if [ -s "$pid_file" ]; then
  saved_pid="$(cat "$pid_file")"
  if is_portal_pid "$saved_pid"; then portal_pid="$saved_pid"; fi
fi

if [ -z "$portal_pid" ]; then
  matches=()
  for process_dir in /proc/[0-9]*; do
    candidate="${process_dir##*/}"
    if is_portal_pid "$candidate"; then matches+=("$candidate"); fi
  done
  if [ "${#matches[@]}" -gt 1 ]; then
    echo 'Multiple Portal processes were found; stop them manually to avoid targeting the wrong process.' >&2
    exit 1
  fi
  if [ "${#matches[@]}" -eq 1 ]; then portal_pid="${matches[0]}"; fi
fi

if [ -z "$portal_pid" ]; then
  rm -f "$pid_file"
  echo 'Portal is not running.'
  exit 0
fi

kill -TERM "$portal_pid"
for _ in {1..100}; do
  if ! kill -0 "$portal_pid" 2>/dev/null; then
    rm -f "$pid_file"
    echo "Portal stopped (PID $portal_pid)."
    exit 0
  fi
  sleep 0.1
done

echo "Portal did not stop within 10 seconds (PID $portal_pid)." >&2
exit 1
