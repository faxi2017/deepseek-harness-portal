#!/bin/bash
# Run in the Docker daemon's host network namespace, never in a tenant.
set -euo pipefail
subnet="${1:?tenant subnet required}"
[[ "$subnet" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || exit 1
ipt() { iptables -w 10 "$@"; }
add() { ipt -C "$@" 2>/dev/null || ipt -I "$1" 1 "${@:2}"; }
# Fail rather than installing ineffective rules on a different firewall backend.
ipt -S DOCKER-USER >/dev/null
# Do not flush any existing chains. Each rule is scoped to this subnet.
for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 "$subnet"; do
  add DOCKER-USER -s "$subnet" -d "$destination" -j REJECT
done
add INPUT -s "$subnet" -j REJECT
# Permit replies to connections initiated by Portal on the host.
add INPUT -s "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
add DOCKER-USER -s "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
printf 'Docker tenant egress rules ready for %s\n' "$subnet"
