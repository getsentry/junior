#!/usr/bin/env bash

set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ci-paths.sh"
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT

git -C "$repo" init --quiet
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
echo base > "$repo/base.txt"
git -C "$repo" add .
git -C "$repo" commit --quiet -m base
base_sha="$(git -C "$repo" rev-parse HEAD)"
filters=(ci core dashboard docs evals example lint_config plugins release repo)

check() {
  local name="$1"
  local file="$2"
  local true_filters="$3"
  local expected_full="$4"

  git -C "$repo" reset --quiet --hard "$base_sha"
  git -C "$repo" clean --quiet -fd
  mkdir -p "$repo/$(dirname "$file")"
  echo "$name" > "$repo/$file"
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m "$name"

  local output="$repo/$name.out"
  (
    cd "$repo"
    GITHUB_EVENT_NAME=pull_request \
      BASE_SHA="$base_sha" \
      HEAD_SHA="$(git rev-parse HEAD)" \
      GITHUB_OUTPUT="$output" \
      "$script"
  )

  for filter in "${filters[@]}"; do
    local value=false
    if [[ " $true_filters " == *" $filter "* ]]; then
      value=true
    fi
    grep --quiet --line-regexp "$filter=$value" "$output"
  done
  grep --quiet --line-regexp "full=$expected_full" "$output"
  [[ "$(wc -l < "$output")" -eq 11 ]]
}

check docs packages/docs/guide.md "docs release" false
check core packages/junior/src/example.ts "core dashboard example" false
check plugin packages/junior-sentry/src/example.ts plugins false
check repo packages/new/package.json "release repo" true
check selector .github/scripts/ci-paths.sh ci false
check unknown misc/file.txt "" true

push_output="$repo/push.out"
GITHUB_EVENT_NAME=push GITHUB_OUTPUT="$push_output" "$script"
for filter in "${filters[@]}"; do
  grep --quiet --line-regexp "$filter=true" "$push_output"
done
grep --quiet --line-regexp full=true "$push_output"
[[ "$(wc -l < "$push_output")" -eq 11 ]]

invalid_output="$repo/invalid.out"
if GITHUB_EVENT_NAME=pull_request \
  BASE_SHA=invalid \
  HEAD_SHA="$(git -C "$repo" rev-parse HEAD)" \
  GITHUB_OUTPUT="$invalid_output" \
  "$script" 2>/dev/null; then
  exit 1
fi

missing_output="$repo/missing.out"
if GITHUB_EVENT_NAME=pull_request \
  BASE_SHA=1111111111111111111111111111111111111111 \
  HEAD_SHA="$(git -C "$repo" rev-parse HEAD)" \
  GITHUB_OUTPUT="$missing_output" \
  "$script" 2>/dev/null; then
  exit 1
fi
