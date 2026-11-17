#!/bin/bash
# Build a signed Release and upload it to TestFlight (fastlane `ios beta`).
# CI runs it from .github/workflows/ios-beta.yml.
#
# Needs CODESIGN_TOKEN and MATCH_GIT_USERNAME for the match repo, plus the
# MATCH_PASSWORD and APP_STORE_CONNECT_* values that fastlane/Fastfile reads.
set -euo pipefail

: "${CODESIGN_TOKEN:?}" "${MATCH_GIT_USERNAME:?}"

MATCH_GIT_BASIC_AUTHORIZATION="$(printf '%s:%s' "$MATCH_GIT_USERNAME" "$CODESIGN_TOKEN" | base64)"
# GitHub masks secrets, but not this value derived from one.
[[ -z "${GITHUB_ACTIONS:-}" ]] || echo "::add-mask::$MATCH_GIT_BASIC_AUTHORIZATION"
export MATCH_GIT_BASIC_AUTHORIZATION

cd "$(dirname "$0")/.."
exec bundle exec fastlane ios beta
