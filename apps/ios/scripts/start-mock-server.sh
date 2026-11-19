#!/bin/bash
# Build the dashboard, start the mock MCP server in the background, and wait
# until it answers. The server keeps running after this script exits.
#
#   scripts/start-mock-server.sh [log-file]
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/../../.." && pwd)"
log_file="${1:-${RUNNER_TEMP:-/tmp}/junior-ios-mock-server.log}"
url="http://127.0.0.1:${PORT:-4317}/"

cd "$repo_dir"
pnpm --filter "@sentry/junior-dashboard..." run build
node apps/ios/scripts/mock-server.mjs >"$log_file" 2>&1 &

for _ in $(seq 60); do
  curl -sf "$url" >/dev/null && exit 0
  sleep 1
done
echo "mock server did not answer on $url" >&2
cat "$log_file" >&2
exit 1
