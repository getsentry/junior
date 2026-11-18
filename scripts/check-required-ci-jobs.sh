#!/bin/sh
# Pass when every job in NEEDS_JSON (the `needs` context) succeeded or was
# skipped. Path-gated jobs skip on pull requests. The `changes` job must
# succeed, because the gates are unknown without it.
set -eu

failed=$(jq -r '
  (select(.changes.result != "success")
    | "changes: \(.changes.result // "missing")"),
  (to_entries[]
    | select(.key != "changes")
    | select(.value.result != "success" and .value.result != "skipped")
    | "\(.key): \(.value.result)")
' <<JSON
$NEEDS_JSON
JSON
)

if [ -n "$failed" ]; then
  printf 'Failed CI jobs:\n%s\n' "$failed"
  exit 1
fi
