---
title: Route & Handler Surface
description: Public HTTP routes exposed by Junior runtime handlers.
type: reference
prerequisites:
  - /start-here/quickstart/
related:
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

When `createApp({ dashboard })` mounts `@sentry/junior-dashboard`, the dashboard package owns `/`, `/conversations`, `/conversations/*`, `/locations`, `/locations/*`, `/people`, `/people/*`, `/system`, `/system/*`, `/_junior/dashboard/client.js`, `/auth/login`, `/api/auth/*`, and the authenticated product API routes `/api/health`, `/api/runtime`, `/api/plugins`, `/api/plugins/*`, `/api/plugin-reports`, `/api/skills`, `/api/conversations`, `/api/conversations/*`, `/api/locations`, `/api/locations/*`, `/api/people`, `/api/people/*`, `/api/config`, and `/api/me`; use `/health` for unauthenticated health checks. Plugin API routes are mounted under `/api/plugins/:plugin/*` and inherit auth. The dashboard also authenticates the ACP browser confirmation route.

Handled `POST` routes:

- `/api/internal/agent-dispatch`
- `/api/internal/agent/continue`
- `/api/internal/plugin/tasks`
- `/api/webhooks/:platform` (Slack path is `/api/webhooks/slack`)

`GET`, `POST`, and `DELETE /api/acp` always expose ACP v1 Streamable HTTP.
When the app configures the dashboard, it also mounts the authenticated
`/_junior/acp/auth/:transactionId` browser route. Clients authenticate through
ACP URL elicitation. The user enters the verification code shown by the client,
then completes the dashboard Google sign-in flow. Personal tokens do not grant
access. ACP stores transport records in the configured `StateAdapter`.
Production Redis state supports requests from different app instances. Live
SSE requests still end at the deployment request limit. Clients must reconnect
and call `session/load` after that limit.

## Expected behavior

- Unknown routes return `404`.
- Queue callbacks validate queue topics and process conversation work or plugin
  background tasks.
- Webhook handler logs and surfaces non-success behavior for operators.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) to validate these routes in your deployment. Inspect the exported TypeScript interfaces and their code comments when integrating with the runtime.
