#!/bin/bash
# Read-only deployment prerequisite inspection.
set -u
if [ "$(uname -s)" != Linux ]; then
  printf 'Run on the Linux Docker server.\n' >&2
  exit 1
fi
printf 'Operating system and runtime user\n'
cat /etc/os-release
uname -m
id
printf '\nInstalled tools\n'
for tool in node npm git docker; do
  if command -v "$tool" >/dev/null 2>&1; then "$tool" --version; else printf '%s missing\n' "$tool"; fi
done
printf '\nDocker runtime\n'
if command -v docker >/dev/null 2>&1; then
  timeout 20s docker info --format 'version={{.ServerVersion}} os={{.OSType}} cgroup={{.CgroupVersion}} security={{json .SecurityOptions}}' || true
fi
printf '\nCapacity\n'
free -h
df -h /
printf '\nPortal and tenant listeners\n'
ss -ltn | awk '{port=$4; sub(/.*:/,"",port); if (NR==1 || (port>=7000 && port<=7101) || (port>=18000 && port<=18100)) print}'
printf '\nInspection complete; no services or rules were changed.\n'
