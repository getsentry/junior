#!/usr/bin/env bash
set -eu

scenario=${1:?scenario required}
case "$scenario" in
  earlier-denial|denial-after-apply) ;;
  *) printf 'unknown scenario: %s\n' "$scenario" >&2; exit 2 ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state="$root/.state"
project="$root/project"
status=$(git -C "$project" show HEAD:src/status.ts)
if [ "$status" != 'export const releaseStatus = "shipped";' ]; then
  printf 'local commit does not contain shipped status\n' >&2
  exit 2
fi

attempts=$(cat "$state/attempts")
attempts=$((attempts + 1))
printf '%s\n' "$attempts" > "$state/attempts"

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
esac
