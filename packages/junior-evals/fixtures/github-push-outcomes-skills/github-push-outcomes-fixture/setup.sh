#!/usr/bin/env bash
set -eu

scenario=${1:?scenario required}
case "$scenario" in
  earlier-denial|denial-after-apply) ;;
  *) printf 'unknown scenario: %s\n' "$scenario" >&2; exit 2 ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project="$root/project"
state="$root/.state"
rm -rf "$state" "$project/.git"
mkdir -p "$state"
printf '0\n' > "$state/attempts"
printf 'absent\n' > "$state/remote-status"

git -C "$project" init -b junior/push-outcome
git -C "$project" config user.name "Junior Eval"
git -C "$project" config user.email "junior-eval@example.com"
printf 'export const releaseStatus = "pending";\n' > "$project/src/status.ts"
git -C "$project" add src/status.ts
git -C "$project" commit -m "Add pending release status"
printf 'initialized %s push fixture\n' "$scenario"
