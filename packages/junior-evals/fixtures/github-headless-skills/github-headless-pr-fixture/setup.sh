#!/usr/bin/env bash
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project="$root/project"
remote="$root/remote.git"

if [ ! -d "$remote" ]; then
  git init --bare "$remote"
fi

if [ ! -d "$project/.git" ]; then
  git -C "$project" init -b junior/fix-ci
  git -C "$project" config user.name "Junior Eval"
  git -C "$project" config user.email "junior-eval@example.com"
  git -C "$project" add src/status.ts
  git -C "$project" \
    commit -m "Add failing status fixture"
  git -C "$project" remote add origin "$remote"
  git -C "$project" push -u origin junior/fix-ci
fi
