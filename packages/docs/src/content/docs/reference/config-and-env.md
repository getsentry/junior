---
title: Config & Environment
description: Required and optional environment variables for runtime and plugins.
---

## Core runtime

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | Yes | Verifies Slack request signatures. |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes | Posts thread replies and calls Slack APIs. |
| `REDIS_URL` | Yes | Queue and runtime state storage. |
| `JUNIOR_BOT_NAME` | No | Bot display/config naming. |
| `AI_MODEL` | No | Primary model selection override. |
| `AI_FAST_MODEL` | No | Faster model for lightweight tasks. |
| `JUNIOR_BASE_URL` | No | Canonical base URL for callback/auth URL generation. |
| `AI_GATEWAY_API_KEY` | No | AI gateway auth if used in your setup. |

## GitHub plugin

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_APP_ID` | Yes | GitHub App identity. |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App signing key. |
| `GITHUB_INSTALLATION_ID` | Yes | Repository/org installation target. |

## Sentry plugin

| Variable | Required | Purpose |
| --- | --- | --- |
| `SENTRY_CLIENT_ID` | Yes | OAuth client ID. |
| `SENTRY_CLIENT_SECRET` | Yes | OAuth client secret. |

## Verification

- Validate required variables exist in deployment environment.
- Redeploy after variable changes.
- Run one end-to-end Slack thread action per enabled integration.
