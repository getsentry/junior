#!/usr/bin/env bash

set -euo pipefail

filters=(ci core dashboard docs evals example lint_config plugins release repo)

if [[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
  for filter in "${filters[@]}"; do
    echo "$filter=true" >> "$GITHUB_OUTPUT"
  done
  echo "full=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [[ ! "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ || ! "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected full pull request base and head SHAs" >&2
  exit 1
fi

matched=false

match() {
  local filter="$1"
  shift

  local status
  set +e
  git diff --quiet "$BASE_SHA...$HEAD_SHA" -- "$@"
  status=$?
  set -e

  local value
  case "$status" in
    0) value=false ;;
    1)
      value=true
      matched=true
      ;;
    *)
      echo "git diff failed for $filter" >&2
      exit "$status"
      ;;
  esac

  printf -v "$filter" "%s" "$value"
  echo "$filter=$value" >> "$GITHUB_OUTPUT"
}

match ci .github/workflows .github/actions .github/scripts
match core packages/junior packages/junior-plugin-api packages/junior-scheduler packages/junior-testing specs policies
match dashboard packages/junior-dashboard packages/junior packages/junior-plugin-api
match docs packages/docs README.md specs policies
match evals packages/junior-evals
match example apps/example packages/junior packages/junior-plugin-api
match lint_config ast-grep sgconfig.yml
match plugins \
  packages/junior-agent-browser \
  packages/junior-amplitude \
  packages/junior-cloudflare \
  packages/junior-datadog \
  packages/junior-github \
  packages/junior-hex \
  packages/junior-linear \
  packages/junior-maintenance \
  packages/junior-memory \
  packages/junior-notion \
  packages/junior-sentry \
  packages/junior-vercel
match repo \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  ":(glob)tsconfig*.json" \
  ":(glob)packages/*/package.json" \
  ":(glob)apps/*/package.json"
match release \
  .craft.yml \
  .github/workflows/ci.yml \
  .github/workflows/release.yml \
  CONTRIBUTING.md \
  README.md \
  scripts/bump-release-versions.mjs \
  scripts/check-release-config.mjs \
  ":(glob)packages/*/package.json" \
  packages/docs

if [[ "$repo" == "true" || "$matched" == "false" ]]; then
  echo "full=true" >> "$GITHUB_OUTPUT"
else
  echo "full=false" >> "$GITHUB_OUTPUT"
fi
