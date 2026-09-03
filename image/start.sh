#!/bin/bash
set -euo pipefail
args=(web --no-open --host 0.0.0.0 --port "${PORT:-3000}")
if [ -n "${TRUSTED_HOST:-}" ]; then
  args+=(--trusted-host "$TRUSTED_HOST")
fi
cd /workspace
exec node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js "${args[@]}"
