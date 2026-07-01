---
title: Dashboard
description: Mount the authenticated Junior dashboard with Google domain auth.
type: tutorial
summary: Add the dashboard package to a Nitro deployment and protect diagnostics with Better Auth and Google domain authorization.
prerequisites:
  - /start-here/existing-app/
  - /reference/config-and-env/
related:
  - /reference/handler-surface/
  - /operate/security-hardening/
  - /start-here/verify-and-troubleshoot/
---

Use `@sentry/junior-dashboard` when you want browser access to Junior runtime diagnostics without exposing plugin, skill, or filesystem discovery publicly. The dashboard mounts into the same Nitro deployment as Junior, but its Better Auth session only protects dashboard routes.

## Install

Install the dashboard package next to `@sentry/junior`:

```bash
pnpm add @sentry/junior-dashboard
```

## Configure the dashboard

Pass `dashboard` to `createApp()`. Configure the Google Workspace domain that
should be allowed to view the dashboard:

```ts title="server.ts"
import { createApp } from "@sentry/junior";
import { plugins } from "./plugins";

export default await createApp({
  dashboard: {
    allowedGoogleDomains: ["sentry.io"],
    trustedOrigins: ["https://<your-domain>"],
  },
  plugins,
});
```

Point the Junior Nitro module at the same dashboard policy and plugin module:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      dashboard: {
        allowedGoogleDomains: ["sentry.io"],
        trustedOrigins: ["https://<your-domain>"],
      },
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

You can also provide the same authorization policy through deployment environment variables:

| Variable                           | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `JUNIOR_DASHBOARD_GOOGLE_DOMAINS`  | Comma-separated or JSON array of allowed Google domains.      |
| `JUNIOR_DASHBOARD_ALLOWED_EMAILS`  | Comma-separated or JSON array of explicit email allowlist.    |
| `JUNIOR_DASHBOARD_TRUSTED_ORIGINS` | Comma-separated or JSON array of Better Auth trusted origins. |
| `JUNIOR_DASHBOARD_AUTH_REQUIRED`   | Set to `false` only for explicit local dashboard auth bypass. |

The dashboard package owns these routes:

| Route                          | Purpose                                 |
| ------------------------------ | --------------------------------------- |
| `/`                            | Authenticated command-center UI.        |
| `/conversations`               | Authenticated conversation-history UI.  |
| `/plugins`                     | Authenticated plugin reporting UI.      |
| `/_junior/dashboard/client.js` | Authenticated dashboard browser bundle. |
| `/auth/login`                  | Dashboard Google login starter.         |
| `/api/auth/*`                  | Better Auth Google login and callbacks. |

`/health` remains the public minimal Junior runtime health response.

The current authenticated product API slices are:

| Endpoint                           | Purpose                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/api/health`                      | Health status for the command center pulse.                                                                |
| `/api/runtime`                     | Runtime paths, providers, skills, and packages.                                                            |
| `/api/plugins`                     | Loaded plugin list.                                                                                        |
| `/api/plugins/:plugin/*`           | Authenticated, namespaced API routes contributed by enabled plugins.                                       |
| `/api/skills`                      | Discovered skill list.                                                                                     |
| `/api/conversations`               | Recent conversation feed from the conversation activity index.                                             |
| `/api/conversations/stats`         | Aggregate conversation stats, people/place leaderboards, and sampling metadata.                            |
| `/api/plugin-reports`              | Sanitized plugin operational summaries.                                                                    |
| `/api/conversations/:conversation` | Conversation header metadata and expiring transcript; private conversations return redacted metadata only. |
| `/api/config`                      | Safe dashboard config signals and feature readiness.                                                       |
| `/api/me`                          | Signed-in dashboard identity.                                                                              |

The dashboard UI is a React client using React Router for browser views and TanStack Query for authenticated product API state. `/` shows command-center health, aggregate conversation stats, and recent run durations; `/conversations` shows conversation history; `/conversations/:conversation` shows the transcript and run/tool-call detail for one conversation; `/plugins` shows loaded plugin inventory and plugin operational summaries. The dashboard does not wrap Slack webhooks, provider OAuth callbacks, sandbox egress, or `/api/internal/*`.
The conversation feed is backed by the bounded conversation activity index. Conversation detail joins header metadata, run metadata, and transcript data from expiring session stores, so old transcripts disappear when session state expires. Conversation detail pages source their header and Sentry conversation link from `/api/conversations/:conversation`, not from the recent feed. When `SENTRY_DSN` initializes the runtime and `SENTRY_ORG_SLUG` is set, conversation detail includes a Sentry conversation link; when the runtime captures a trace ID, conversation detail shows it with the run metadata.
The conversation stats endpoint is separate from the recent feed and includes `sampleLimit`, `sampleSize`, and `truncated` fields so the UI can mark bounded aggregates. Stats are built from durable conversation-index records for fast SQL-backed counts, locations, requesters, and latest status. Run duration and token totals appear on feed and detail responses until Junior stores durable SQL run summaries.
Dashboard dates use `JUNIOR_TIMEZONE`, defaulting to `America/Los_Angeles`.

For local dashboard visual QA, pass `mockConversations: true` in the dashboard config or set `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true` for the env-configured path. The sample conversations are read-only reporting fixtures and appear before real conversation records.

## Configure Google auth

Create a Google OAuth client for the deployment origin. Add this redirect URI:

```text
https://<your-domain>/api/auth/callback/google
```

Set the required environment variables:

| Variable               | Purpose                     |
| ---------------------- | --------------------------- |
| `GOOGLE_CLIENT_ID`     | Google OAuth client ID.     |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |

Dashboard cookies are signed with `JUNIOR_SECRET` by default. Set `BETTER_AUTH_SECRET` only when you need a separate rotation boundary for browser sessions.
Dashboard callbacks use `dashboard.baseURL`, `JUNIOR_BASE_URL`, Vercel URL envs, or local dev by default. Set `BETTER_AUTH_URL` only when dashboard auth needs a different public origin. The same public origin is used for Slack footer links to dashboard conversation pages.

## Verify

After deployment:

1. `GET https://<your-domain>/health` returns a minimal health JSON response.
2. `GET https://<your-domain>/api/info` returns `404`.
3. Opening `https://<your-domain>/` starts Google login.
4. A user from the configured Google Workspace domain reaches the dashboard.
5. A user outside the configured domain receives `403`.

## Next step

Use [Security Hardening](/operate/security-hardening/) to review production auth boundaries, then use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for deployment smoke checks.
