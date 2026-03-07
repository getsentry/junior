---
title: Route & Handler Surface
description: Public HTTP routes exposed by Junior runtime handlers.
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
