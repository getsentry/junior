#!/bin/bash
# Save screenshots of the app's main screens for pull request review. Needs
# the mock MCP server (scripts/start-mock-server.sh).
#
#   scripts/screenshots.sh <out-dir>
#
# File names are `<screen>__<theme>.png`, the Frameshift label format.
set -euo pipefail

(($# == 1)) || { echo "usage: $0 <out-dir>" >&2; exit 2; }

conversation="/conversations/slack:CQA123:1770003600.000200"

exec "$(dirname "$0")/sim.sh" shots "$1" \
  "conversations__dark|/|dark" \
  "conversations__light|/|light" \
  "conversation__dark|$conversation|dark" \
  "conversation-details__dark|$conversation?details=1|dark" \
  "inbox__dark|/review|dark" \
  "review-item__dark|/review?item=qa-rollout|dark" \
  "automations__dark|/automations|dark" \
  "automation__dark|/automations/scheduled-1|dark" \
  "drawer__dark|/?drawer=1|dark" \
  "settings__dark|/settings|dark"
