#!/usr/bin/env bash
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
remote="$root/remote.git"
branch="refs/heads/junior/fix-ci"

test "$(git --git-dir="$remote" rev-list --count "$branch")" = "2"
test "$(git --git-dir="$remote" show "$branch:src/status.ts")" = 'export const buildStatus = "fixed";'
printf 'verified remote branch contains the pushed fix\n'
