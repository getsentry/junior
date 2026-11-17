#!/bin/sh
# Build the dashboard and run one Playwright project from its e2e suite.
# PLAYWRIGHT_PROJECT names the project, such as classic or inbox.
set -eu

: "${PLAYWRIGHT_PROJECT:?Set PLAYWRIGHT_PROJECT to a Playwright project name}"
exec pnpm test:e2e:dashboard --project="$PLAYWRIGHT_PROJECT"
