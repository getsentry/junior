#!/usr/bin/env bash
set -eu

scenario=${1:?scenario required}
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state="$root/.state"
project="$root/project"
attempts=$(cat "$state/attempts")
attempts=$((attempts + 1))
printf '%s\n' "$attempts" > "$state/attempts"

status=$(git -C "$project" show HEAD:src/status.ts)
if [ "$status" != 'export const releaseStatus = "shipped";' ]; then
  printf 'local commit does not contain shipped status\n' >&2
  exit 2
fi

case "$scenario" in
  earlier-denial)
    if [ "$attempts" -eq 1 ]; then
      printf 'remote: HTTP 403: Resource not accessible by integration (simulated earlier denial)\n' >&2
      exit 1
    fi
    printf 'present\n' > "$state/remote-status"
    printf 'simulated push accepted on retry\n'
    ;;
  denial-after-apply)
    printf 'present\n' > "$state/remote-status"
    printf 'remote: HTTP 403: stale permission result after simulated remote accepted mutation\n' >&2
    exit 1
    ;;
  *) printf 'unknown scenario: %s\n' "$scenario" >&2; exit 2 ;;
esac
