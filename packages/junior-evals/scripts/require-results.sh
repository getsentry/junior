#!/bin/sh
# Fail when an eval run wrote no results file, so a setup or runtime crash
# is a hard failure.
#
# Usage: scripts/require-results.sh <results.json>
set -eu

result_file=$1
if [ ! -f "$result_file" ]; then
  printf '::error::missing eval results (%s). Treat setup/runtime crashes as hard failures.\n' "$result_file"
  exit 1
fi
