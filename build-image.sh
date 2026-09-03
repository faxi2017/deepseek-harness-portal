#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec node scripts/build-image.mjs
