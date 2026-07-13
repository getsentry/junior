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

The Hono app created by `createApp()` mounts a mix of root-level and `/api` routes.

Handled `GET` routes:

- `/`
- `/health`
- `/api/internal/heartbeat`
- `/api/oauth/callback/:provider`
- `/api/oauth/callback/mcp/:provider`

When `createApp({ dashboard })` mounts `@sentry/junior-dashboard`, the dashboard package owns `/`, `/conversations`, `/conversations/*`, `/people`, `/people/*`, `/plugins`, `/_junior/dashboard/client.js`, `/auth/login`, `/api/auth/*`, and the authenticated product API routes `/api/health`, `/api/runtime`, `/api/plugins`, `/api/plugins/*`, `/api/plugin-reports`, `/api/skills`, `/api/conversations`, `/api/conversations/*`, `/api/people`, `/api/people/*`, `/api/config`, and `/api/me`; use `/health` for unauthenticated health checks. Plugin API routes are mounted under `/api/plugins/:plugin/*` and inherit auth.

Handled `POST` routes:

- `/api/internal/agent-dispatch`
- `/api/internal/agent/continue`
- `/api/internal/plugin/tasks`
- `/api/webhooks/:platform` (Slack path is `/api/webhooks/slack`)

## Expected behavior

- Unknown routes return `404`.
- Queue callbacks validate queue topics and process conversation work or plugin
  background tasks.
- Webhook handler logs and surfaces non-success behavior for operators.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) to validate these routes in your deployment, then inspect generated signatures in [API Reference Guide](/reference/api/).
