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

| Variable                                    | Required | Purpose                                                                                                                                              |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`                      | Yes      | Verifies Slack request signatures.                                                                                                                   |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes      | Posts thread replies and calls Slack APIs.                                                                                                           |
| `REDIS_URL`                                 | Yes      | Queue and runtime state storage.                                                                                                                     |
| `JUNIOR_BOT_NAME`                           | No       | Bot display/config naming.                                                                                                                           |
| `AI_MODEL`                                  | No       | Primary model selection override for main assistant turns. Defaults to `openai/gpt-5.4`; Junior chooses the reasoning effort per turn automatically. |
| `AI_FAST_MODEL`                             | No       | Faster model for lightweight tasks and routing/classification passes before the main turn begins. Defaults to `openai/gpt-5.4-mini`.                 |
| `AI_VISION_MODEL`                           | No       | Dedicated image-understanding model; unset disables vision features.                                                                                 |
| `AI_WEB_SEARCH_MODEL`                       | No       | Override for the `webSearch` tool model. Defaults to a search-tuned model; does not fall through to `AI_MODEL`.                                      |
| `JUNIOR_BASE_URL`                           | No       | Canonical base URL for callback/auth URL generation.                                                                                                 |
| `AI_GATEWAY_API_KEY`                        | No       | AI gateway auth if used in your setup.                                                                                                               |

## Build-time snapshot warmup

If your build command runs `junior snapshot create`:

- `REDIS_URL` must be available during build.
- `VERCEL_OIDC_TOKEN` must be available during build (via Vercel OIDC settings).

## Sandbox credential egress

If enabled plugins use host-managed credentials inside Vercel Sandbox, Junior forwards registered provider domains through its credential egress proxy. The proxy verifies each Vercel-signed sandbox request and requires a signed requester context before it injects credentials lazily.

The egress proxy verifies Vercel-signed Sandbox OIDC tokens per request to authenticate the sandbox VM; requester authorization comes from the signed forwarding-route context bound to that VM session. No separate audience, project, or team env vars are required for the proxy.

| Variable                       | Required    | Purpose                                                                                                            |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `JUNIOR_BASE_URL`              | Conditional | Public URL for the credential egress proxy, unless Vercel URL envs cover it.                                       |
| `JUNIOR_SANDBOX_EGRESS_SECRET` | No          | Secret for signed sandbox egress requester-context URLs. Falls back to `JUNIOR_INTERNAL_RESUME_SECRET` when unset. |

## GitHub plugin

| Variable                 | Required | Purpose                                         |
| ------------------------ | -------- | ----------------------------------------------- |
| `GITHUB_APP_ID`          | Yes      | GitHub App identity.                            |
| `GITHUB_APP_PRIVATE_KEY` | Yes      | GitHub App signing key.                         |
| `GITHUB_INSTALLATION_ID` | Yes      | Repository/org installation target.             |
| `GITHUB_APP_BOT_NAME`    | Yes      | Git author name, for example `<app-slug>[bot]`. |
| `GITHUB_APP_BOT_EMAIL`   | Yes      | Git author noreply email for the App bot user.  |

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
