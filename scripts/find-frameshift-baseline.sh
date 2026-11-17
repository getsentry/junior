#!/bin/sh
# Write found=true to GITHUB_OUTPUT when Frameshift has saved screenshots for
# BASE_SHA, else found=false. The first default-branch run on a commit saves
# them.
set -eu

: "${BASE_SHA:?Set BASE_SHA to the pull request base commit}"
artifact="frameshift-baseline-v1-${BASE_SHA}"
found=$(timeout 60 gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts?name=${artifact}" --jq '.artifacts | any(.expired == false)')
printf 'found=%s\n' "$found" >> "$GITHUB_OUTPUT"
if [ "$found" != "true" ]; then
  printf 'No baseline exists for %s. The first default-branch run will create it.\n' "$BASE_SHA"
fi
