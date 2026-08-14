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
  - /concepts/data-and-privacy/
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

| Route                           | Purpose                                     |
| ------------------------------- | ------------------------------------------- |
| `/`                             | Personal conversation workspace.            |
| `/conversations`                | Redirect to the personal workspace.         |
| `/conversations/:conversation`  | Workspace with a selected transcript.       |
| `/tasks`                        | Signed-in user's scheduled and event tasks. |
| `/plugins/:plugin/:page/*`      | Core-rendered signed-in plugin page.        |
| `/system`                       | Aggregate runtime and model metrics.        |
| `/system/people`                | Actor activity directory.                   |
| `/system/people/:email`         | Actor activity profile.                     |
| `/system/locations`             | Public location activity directory.         |
| `/system/locations/:location`   | Public location activity detail.            |
| `/system/workspaces`            | Install-wide repository Workspace recipes.  |
| `/system/plugins`               | Loaded plugin and skill inventory.          |
| `/system/plugins/:plugin`       | Plugin details and operational reports.     |
| `/_junior/dashboard/client.js`  | Authenticated dashboard browser bundle.     |
| `/_junior/dashboard/avatar.png` | Authenticated Junior header avatar.         |
| `/auth/login`                   | Dashboard Google login starter.             |
| `/api/auth/*`                   | Better Auth Google login and callbacks.     |

When the GitHub plugin is enabled, open `/system/plugins/github` for its pull
request and issue analytics.

Existing `/people/*` and `/locations/*` links redirect to their corresponding
System routes.

`/health` remains the public minimal Junior runtime health response.

The current authenticated product API slices are:

| Endpoint                                  | Purpose                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/api/health`                             | Dashboard-safe health metadata.                                                                             |
| `/api/runtime`                            | Runtime paths, providers, skills, and packages.                                                             |
| `/api/plugins`                            | Loaded plugin list.                                                                                         |
| `/api/plugins/:plugin/*`                  | Authenticated, namespaced API routes contributed by enabled plugins.                                        |
| `/api/user-pages`                         | Safe navigation metadata for registered plugin pages.                                                       |
| `/api/user-pages/:plugin/:page`           | Viewer-authorized metrics and records for one plugin page.                                                  |
| `/api/tasks`                              | Viewer-owned scheduled and resource-event tasks.                                                            |
| `/api/tasks/:kind/:task`                  | Deletes one viewer-owned scheduled or event task.                                                           |
| `/api/skills`                             | Discovered skill list.                                                                                      |
| `/api/conversations`                      | Recent SQL conversation feed; optional `actorEmail` is a normalized presentation filter, not authorization. |
| `/api/conversations/stats`                | Complete 90-day conversation stats and people/place leaderboards aggregated by SQL.                         |
| `/api/people`                             | Actor directory.                                                                                            |
| `/api/people/:email`                      | Actor profile and recent conversation resources.                                                            |
| `/api/locations`                          | Public location directory and generic private-activity totals.                                              |
| `/api/locations/:location`                | Activity, actors, and recent conversations for one public location.                                         |
| `/api/plugin-reports`                     | Sanitized plugin operational summaries.                                                                     |
| `/api/conversations/:conversation`        | Conversation header metadata and expiring transcript; private transcripts are participant-authorized.       |
| `/api/conversations/:conversation/events` | Earlier transcript event pages selected with a signed `before` cursor.                                      |
| `/api/config`                             | Safe dashboard config signals and feature readiness.                                                        |
| `/api/me`                                 | Signed-in dashboard identity.                                                                               |

For a private conversation, the transcript is available only when the signed-in verified email matches the owning root conversation actor's persisted verified email. Conversation summary resources report that match through `isParticipant`; event-page resources apply the same authorization decision through their projected events and `eventHistory`. Other viewers receive redacted metadata. Top-level conversation resources and System, People, and Location statistics include descendant duration and usage even when child resources are loaded separately. A directly requested child reports only its own metrics.

The dashboard UI is a React client using React Router for browser views and TanStack Query for authenticated product API state. `/` is a focused workspace listing the signed-in actor's conversations in a sidebar; `/conversations/:conversation` selects a transcript in that workspace. `/tasks` combines the signed-in user's scheduled and resource-event tasks. `/conversations` redirects to the personal workspace instead of exposing a global conversation index. `/system` owns runtime metrics and the People, Locations, and Plugins reporting views. People and Locations remain separate pages under System so their directories and detail views stay focused. Each `/system/plugins/:plugin` page shows that plugin's details and operational summaries. Plugins may also register signed-in pages in primary navigation or the profile menu; Junior owns their route, metrics, search, pagination, record inspection, and actions. System always remains the last primary navigation item. The dashboard does not wrap Slack webhooks, provider OAuth callbacks, sandbox egress, or `/api/internal/*`.
On desktop, the conversation sidebar and selected transcript scroll independently within the viewport. Mobile presents the list and selected conversation as separate navigable views.
When dashboard auth is explicitly disabled for local or demo use, Junior uses `dev@example.com` as the verified local viewer. The workspace and API use that viewer for conversation access and writes.
The conversation feed and detail are backed by durable SQL conversation and event records. Retention and purge settings determine when transcript data is removed. Conversation detail returns the latest 500 reporting events by default and a `previousCursor` when earlier events remain. The `limit` query parameter can select between 1 and 1,000 events. Cursors are signed for one conversation; consumers should treat them as opaque.

The dashboard polls the bounded detail resource while a conversation is active and loads earlier pages from the `/events` collection on demand. Conversation detail pages source their header and Sentry conversation link from `/api/conversations/:conversation`, not from the recent feed. When `SENTRY_DSN` initializes the runtime and `SENTRY_ORG_SLUG` is set, conversation detail includes a Sentry conversation link; when the runtime captures a trace ID, conversation detail shows it with the run metadata.
The conversation stats endpoint is separate from the recent feed. PostgreSQL computes complete 90-day counts, locations, actors, status, runtime, token usage, and estimated cost directly from durable conversation-index records; those aggregates are not derived from a bounded recent-row sample.
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
Dashboard callbacks use `dashboard.baseURL`, `JUNIOR_BASE_URL`, Vercel URL envs, or local dev by default. Set `JUNIOR_BASE_URL` to the public origin users should visit. Alternate deployment origins redirect there before Google sign-in so the OAuth state and callback cookies share one host. Slack reply footers and other surfaces that include a dashboard conversation link use the same public origin.

## Verify

After deployment:

1. `GET https://<your-domain>/health` returns a minimal health JSON response.
2. `GET https://<your-domain>/api/info` returns `404`.
3. Opening `https://<your-domain>/` starts Google login.
4. A user from the configured Google Workspace domain reaches the dashboard.
5. A user outside the configured domain receives `403`.

## Next step

Read [Data & Privacy](/concepts/data-and-privacy/) for retention and access rules, then use [Security Hardening](/operate/security-hardening/) and [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for production checks.
