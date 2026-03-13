---
title: Verify & Troubleshoot
description: Post-deploy checks and first-response troubleshooting.
type: troubleshooting
summary: Verify a deployed Junior runtime and isolate common Slack, queue, and auth regressions quickly.
prerequisites:
  - /start-here/quickstart/
related:
  - /operate/observability/
  - /operate/reliability-runbooks/
  - /concepts/execution-model/
---

## Verification sequence

1. Health endpoint: `GET /api/health` returns `status: "ok"`.
2. Slack ingress: mention bot and confirm thread reply appears.
3. Queue callback: verify callback route logs include successful processing.
4. Plugin auth (if enabled): run one real command and confirm expected result.

## Symptom -> likely cause

| Symptom                               | Likely cause                         | First check                                |
| ------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Slack mention receives no reply       | Missing webhook URL or token scopes  | Slack app Event Subscriptions URL + scopes |
| Webhook 401/signature errors          | Incorrect signing secret             | `SLACK_SIGNING_SECRET` value               |
| Message accepted but no threaded work | Queue callback trigger misconfigured | `vercel.json` trigger + callback route     |
| Plugin commands fail auth             | Missing credentials or OAuth state   | Plugin env vars + Sentry connect flow      |

## Useful signals

- `webhook_handler_failed`
- `queue_callback_failed`
- `agent_turn_failed`
- `credential_issue_failed`

## Recovery order

1. Confirm most recent deploy/version boundary.
2. Validate env vars and webhook URLs.
3. Validate queue trigger and callback handler status.
4. Roll back to last known-good deployment if regression is immediate.

## Next step

For runtime internals, read [Execution Model](/concepts/execution-model/).
