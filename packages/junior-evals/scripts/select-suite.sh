#!/bin/sh
# Decide if an isolated eval suite runs on a pull request, and write the
# decision to the GitHub step output and summary.
#
# Usage: scripts/select-suite.sh <suite>
#
# Env: RELEVANT ("true" when the suite's files changed), PR_LABELS
# (comma-separated), AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN, GITHUB_OUTPUT,
# GITHUB_STEP_SUMMARY.
set -eu

suite=$1
gateway_ready=false
if [ -n "${AI_GATEWAY_API_KEY:-}" ] || [ -n "${VERCEL_OIDC_TOKEN:-}" ]; then
  gateway_ready=true
fi

requested=false
case ",${PR_LABELS:-}," in
  *,trigger-evals,* | *,"trigger-evals-$suite",*) requested=true ;;
  *) ;;
esac

should_run=false
if [ "$gateway_ready" = true ] &&
  { [ "${RELEVANT:-}" = true ] || [ "$requested" = true ]; }; then
  should_run=true
fi

printf 'should_run=%s\n' "$should_run" >>"$GITHUB_OUTPUT"
printf '## %s eval selection\n\n- relevant_files_changed: %s\n- requested: %s\n- gateway_ready: %s\n- will_run: %s\n' \
  "$suite" "${RELEVANT:-false}" "$requested" "$gateway_ready" "$should_run" \
  >>"$GITHUB_STEP_SUMMARY"
