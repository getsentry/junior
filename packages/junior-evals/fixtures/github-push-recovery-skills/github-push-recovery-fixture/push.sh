#!/usr/bin/env bash
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state="$root/state"
remote_status=$(cat "$state/remote-status")

attempts=$(cat "$state/attempts")
attempts=$((attempts + 1))
printf '%s\n' "$attempts" > "$state/attempts"

if [ "$remote_status" = "shipped" ]; then
  printf 'duplicate push rejected: remote already contains shipped status\n' >&2
  exit 2
fi

printf 'shipped\n' > "$state/remote-status"
printf 'simulated push accepted: remote_release_status=shipped push_attempts=%s\n' "$attempts"
