#!/bin/sh
# Save screenshots of the app's main screens for pull request review. Needs
# the mock MCP server (scripts/start-mock-server.sh).
#
#   scripts/screenshots.sh <out-dir> [portrait|landscape]
#
# `simctl` cannot rotate a simulator, so landscape shots come from the
# ScreenshotUITests UI test instead of `sim.sh shots`.
# File names are `<screen>__<theme>.png`, the Frameshift label format.
set -eu

usage() {
  echo "usage: $0 <out-dir> [portrait|landscape]" >&2
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
out="$1"
orientation="${2:-portrait}"
scripts="$(dirname "$0")"
conversation="/conversations/slack:CQA123:1770003600.000200"

set -- \
  "conversations__dark|/|dark" \
  "conversations__light|/|light" \
  "conversation__dark|$conversation|dark" \
  "conversation-details__dark|$conversation?details=1|dark" \
  "inbox__dark|/inbox|dark" \
  "review-item__dark|/inbox?item=qa-rollout|dark" \
  "automations__dark|/automations|dark" \
  "automation__dark|/automations/scheduled-1|dark" \
  "drawer__dark|/?drawer=1|dark" \
  "settings__dark|/settings|dark" \
  "changelog__dark|/settings?changelog=1|dark"

case "$orientation" in
  portrait) exec "$scripts/sim.sh" shots "$out" "$@" ;;
  landscape) ;;
  *) usage ;;
esac

mkdir -p "$out"
out_abs="$(cd "$out" && pwd)"
shots=""
for shot in "$@"; do shots="${shots:+$shots;}$shot"; done
# xcodebuild passes TEST_RUNNER_<name> to the tests as <name>.
export TEST_RUNNER_JUNIOR_IOS_SHOTS_DIR="$out_abs"
export TEST_RUNNER_JUNIOR_IOS_SHOTS="$shots"
exec "$scripts/sim.sh" ui-test ScreenshotUITests/testLandscapeShots
