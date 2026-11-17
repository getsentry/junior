#!/bin/bash
# Build a signed Release and upload it to TestFlight (fastlane `ios beta`).
# CI runs it from .github/workflows/ios-beta.yml.
#
# Needs CODESIGN_TOKEN, a GitHub App token for the match repo, plus the
# MATCH_PASSWORD and APP_STORE_CONNECT_* values that fastlane/Fastfile reads.
set -euo pipefail

: "${CODESIGN_TOKEN:?}"

# GitHub App tokens use the fixed user name `x-access-token` over HTTPS.
MATCH_GIT_BASIC_AUTHORIZATION="$(printf 'x-access-token:%s' "$CODESIGN_TOKEN" | base64)"
# GitHub masks secrets, but not this value derived from one.
[[ -z "${GITHUB_ACTIONS:-}" ]] || echo "::add-mask::$MATCH_GIT_BASIC_AUTHORIZATION"
export MATCH_GIT_BASIC_AUTHORIZATION

cd "$(dirname "$0")/.."
exec bundle exec fastlane ios beta
