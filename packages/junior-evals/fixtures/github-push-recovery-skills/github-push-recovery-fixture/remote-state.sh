#!/usr/bin/env bash
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state="$root/state"
status=$(cat "$state/remote-status")
attempts=$(cat "$state/attempts")
printf 'remote_release_status=%s push_attempts=%s\n' "$status" "$attempts"
