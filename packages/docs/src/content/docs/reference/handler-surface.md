---
title: Route & Handler Surface
description: Public HTTP routes exposed by Junior runtime handlers.
type: reference
summary: Reference the public HTTP routes and behavior exposed by Junior runtime handlers.
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/api/
  - /start-here/verify-and-troubleshoot/
---

## `@sentry/junior/handler`

Route this in `app/api/[...path]/route.ts`.

Handled `GET` routes:

- `/api/health`
- `/api/oauth/callback/:provider`

Handled `POST` routes:

- `/api/webhooks/:platform` (Slack path is `/api/webhooks/slack`)

## `@sentry/junior/handlers/queue-callback`

Route this in `app/api/queue/callback/route.ts`.

Handled `POST` route:

- `/api/queue/callback`

## Expected behavior

- Unknown routes return `404`.
- Queue callback validates queue topic and processes thread work.
- Webhook handler logs and surfaces non-success behavior for operators.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) to validate these routes in your deployment, then inspect generated signatures in [API Reference Guide](/reference/api/).
