---
title: Config & Environment
description: Required and optional environment variables for runtime and plugins.
type: reference
prerequisites:
  - /start-here/quickstart/
related:
  - /extend/github-plugin/
  - /extend/sentry-plugin/
  - /operate/security-hardening/
---

## Core runtime

| Variable                                    | Required    | Purpose                                                                                                                                               |
| ------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`                      | Yes         | Verifies Slack request signatures.                                                                                                                    |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes         | Posts thread replies and calls Slack APIs.                                                                                                            |
| `REDIS_URL`                                 | Yes         | Queue and runtime state storage.                                                                                                                      |
| `JUNIOR_SECRET`                             | Yes         | Signs internal queue/callback payloads and sandbox egress requester context.                                                                          |
| `JUNIOR_BOT_NAME`                           | No          | Bot display/config naming.                                                                                                                            |
| `JUNIOR_SLASH_COMMAND`                      | No          | Slack slash command for account-management flows. Defaults to `/jr`; the Slack app command must match this value.                                     |
| `AI_MODEL`                                  | No          | Primary model selection override for main agent runs. Defaults to `openai/gpt-5.4`; Junior chooses the reasoning effort per run automatically.        |
| `AI_FAST_MODEL`                             | No          | Faster model for lightweight tasks and routing/classification passes before the main turn begins. Defaults to `openai/gpt-5.4-mini`.                  |
| `AI_VISION_MODEL`                           | No          | Dedicated image-understanding model; unset disables vision features.                                                                                  |
| `AI_WEB_SEARCH_MODEL`                       | No          | Override for the `webSearch` tool model. Defaults to `openai/gpt-5.4`; does not fall through to `AI_MODEL`.                                           |
| `JUNIOR_BASE_URL`                           | No          | Canonical base URL for callback/auth URL generation.                                                                                                  |
| `JUNIOR_STATE_KEY_PREFIX`                   | No          | Optional namespace prepended to all state-adapter keys, locks, and queues. Use separate prefixes when sharing one Redis database across environments. |
| `CRON_SECRET` or `JUNIOR_SCHEDULER_SECRET`  | Conditional | Bearer token for the internal heartbeat route; use `CRON_SECRET` with Vercel Cron, or `JUNIOR_SCHEDULER_SECRET` for a non-Vercel heartbeat caller.    |
| `JUNIOR_TIMEZONE`                           | No          | Default IANA timezone for scheduler authoring when the scheduler plugin is enabled. Defaults to `America/Los_Angeles`.                                |
| `AI_GATEWAY_API_KEY`                        | No          | AI gateway auth if used in your setup.                                                                                                                |

Generate `JUNIOR_SECRET` with Node, then store the generated value in every environment that runs the same app:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use one stable value per deployment. Rotating it invalidates pending internal queue callbacks and sandbox requester context signed with the previous value.

## Dashboard auth

If you mount `@sentry/junior-dashboard`, set these browser-auth variables:

| Variable               | Required | Purpose                                                                                           |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Yes      | Google OAuth client ID.                                                                           |
| `GOOGLE_CLIENT_SECRET` | Yes      | Google OAuth client secret.                                                                       |
| `BETTER_AUTH_URL`      | No       | Optional dashboard callback origin. Defaults to `JUNIOR_BASE_URL`, Vercel URL envs, or local dev. |
| `BETTER_AUTH_SECRET`   | No       | Optional override for dashboard cookies. Defaults to `JUNIOR_SECRET`.                             |

Configure allowed Google Workspace domains in `juniorDashboardPlugin()` for normal deployments. Set these optional policy variables when you prefer environment-managed dashboard authorization:

| Variable                              | Required | Purpose                                                       |
| ------------------------------------- | -------- | ------------------------------------------------------------- |
| `JUNIOR_DASHBOARD_GOOGLE_DOMAINS`     | No       | Comma-separated or JSON array of allowed Google domains.      |
| `JUNIOR_DASHBOARD_ALLOWED_EMAILS`     | No       | Comma-separated or JSON array of explicit email allowlist.    |
| `JUNIOR_DASHBOARD_TRUSTED_ORIGINS`    | No       | Comma-separated or JSON array of Better Auth trusted origins. |
| `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS` | No       | Set to `true` to overlay local/demo visual-QA fixtures.       |

For local/demo dashboard visual QA, set `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true` to overlay sample conversation fixtures.

## Build-time snapshot warmup

If your build command runs `junior snapshot create`:

- `REDIS_URL` must be available during build.
- `VERCEL_OIDC_TOKEN` must be available during build (via Vercel OIDC settings).

## Sandbox credential egress

If enabled plugins use host-managed credentials inside Vercel Sandbox, Junior forwards registered provider domains through its credential egress proxy. The proxy verifies each Vercel-signed sandbox request and requires a signed requester context before it injects credentials lazily.

The egress proxy verifies Vercel-signed Sandbox OIDC tokens per request to authenticate the sandbox VM; requester authorization comes from the forwarding-route context signed with `JUNIOR_SECRET` and bound to that VM session. No separate audience, project, or team env vars are required for the proxy.

| Variable          | Required    | Purpose                                                                      |
| ----------------- | ----------- | ---------------------------------------------------------------------------- |
| `JUNIOR_BASE_URL` | Conditional | Public URL for the credential egress proxy, unless Vercel URL envs cover it. |

## GitHub plugin

| Variable                   | Required | Purpose                                             |
| -------------------------- | -------- | --------------------------------------------------- |
| `GITHUB_APP_ID`            | Yes      | GitHub App identity.                                |
| `GITHUB_APP_CLIENT_ID`     | Yes      | GitHub App OAuth client ID for user-token auth.     |
| `GITHUB_APP_CLIENT_SECRET` | Yes      | GitHub App OAuth client secret for user-token auth. |
| `GITHUB_APP_PRIVATE_KEY`   | Yes      | GitHub App signing key.                             |
| `GITHUB_INSTALLATION_ID`   | Yes      | Repository/org installation target.                 |
| `GITHUB_APP_BOT_NAME`      | Yes      | Git author name, for example `<app-slug>[bot]`.     |
| `GITHUB_APP_BOT_EMAIL`     | Yes      | Git author noreply email for the App bot user.      |

## Sentry plugin

| Variable               | Required | Purpose              |
| ---------------------- | -------- | -------------------- |
| `SENTRY_CLIENT_ID`     | Yes      | OAuth client ID.     |
| `SENTRY_CLIENT_SECRET` | Yes      | OAuth client secret. |

## Install-wide config defaults

Pass `configDefaults` to `createApp()` to set provider defaults across all conversations:

```ts
import { createApp } from "@sentry/junior";

const app = await createApp({
  configDefaults: {
    "sentry.org": "sentry",
    "github.org": "myorg",
    "github.repo": "myorg/myrepo",
  },
});
```

Keys must be registered plugin config keys. Channel-scoped overrides (`jr-rpc config set`) take precedence.

## Verification

- Validate required variables exist in deployment environment.
- Redeploy after variable changes.
- Run one end-to-end Slack thread action per enabled integration.

## Next step

Use [Plugin Auth & Context](/reference/runtime-commands/) to verify plugin auth and target-context behavior after env changes, then monitor with [Observability](/operate/observability/).
