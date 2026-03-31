---
title: Route & Handler Surface
description: Public HTTP routes exposed by Junior runtime handlers.
type: reference
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/api/
  - /start-here/verify-and-troubleshoot/
---

## `@sentry/junior` (via `createApp()`)

The Hono app created by `createApp()` mounts all routes under `/api`.

Handled `GET` routes:

- `/api/health`
- `/api/oauth/callback/:provider`
- `/api/oauth/callback/mcp/:provider`

Handled `POST` routes:

- `/api/webhooks/:platform` (Slack path is `/api/webhooks/slack`)

## Expected behavior

- Unknown routes return `404`.
- Queue callback validates queue topic and processes thread work.
- Webhook handler logs and surfaces non-success behavior for operators.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) to validate these routes in your deployment, then inspect generated signatures in [API Reference Guide](/reference/api/).
