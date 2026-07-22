#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
started_marker="$script_dir/.slow-integration-test-started"
result_file="$script_dir/slow-test-result.txt"

if [[ ! -f "$started_marker" ]]; then
  touch "$started_marker"
  sleep 50
fi

printf 'slow integration test passed after continuation\n' >"$result_file"
cat "$result_file"
