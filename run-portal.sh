#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo 'Copy .env.example to .env and configure it first.' >&2; exit 1; }
# Runtime preflight applies the Docker firewall before listening.
exec node --env-file=.env portal/src/index.js
