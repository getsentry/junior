---
title: Quickstart
description: Wire Junior locally and deploy it to Vercel in one end-to-end setup flow.
type: tutorial
summary: Set up Junior once, verify local Slack thread execution, then deploy the same runtime to Vercel.
prerequisites: []
related:
  - /extend/plugins-overview/
  - /extend/custom-plugins/
  - /start-here/verify-and-troubleshoot/
---

## Prerequisites

- Node.js 20+
- pnpm
- A Slack app with signing secret + bot token
- Redis URL
- A Vercel account

## Setup

### Create a new app

```bash
npx @sentry/junior init my-bot
cd my-bot
pnpm install
```

### Install Junior with a plugin package

```bash
pnpm add @sentry/junior @sentry/junior-github
```

This keeps the model extension-first from the start: runtime + at least one integration package.

### Wire routes

```ts title="app/api/[...path]/route.ts"
export { GET, POST } from "@sentry/junior/handler";
export const runtime = "nodejs";
```

```ts title="app/api/queue/callback/route.ts"
export { POST } from "@sentry/junior/handlers/queue-callback";
export const runtime = "nodejs";
```

### Enable Next.js runtime config

```ts title="next.config.mjs"
import { withJunior } from "@sentry/junior/config";

export default withJunior();
```

```ts title="instrumentation.ts"
export { register, onRequestError } from "@sentry/junior/instrumentation";
```

If your app has no root layout yet:

```ts
export { default } from "@sentry/junior/app/layout";
```

### Set required env vars

```bash
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=...
REDIS_URL=...
```

### Run locally

```bash
pnpm dev
```

### Verify locally

- `GET http://localhost:3000/api/health` returns JSON with `status: "ok"`.
- A Slack mention triggers a threaded response.

## Deploy to Vercel

### Link the project

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest link
```

### Add queue trigger

```json title="vercel.json"
{
  "functions": {
    "app/api/queue/callback/route.ts": {
      "experimentalTriggers": [
        {
          "type": "queue/v2beta",
          "topic": "junior-thread-message"
        }
      ]
    }
  }
}
```

### Configure production environment

Required:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN` (or `SLACK_BOT_USER_TOKEN`)
- `REDIS_URL`

Recommended:

- `JUNIOR_BOT_NAME`
- `AI_MODEL`
- `AI_FAST_MODEL`

Optional:

- `JUNIOR_BASE_URL`
- `AI_GATEWAY_API_KEY`

### Configure Slack request URL

Set Event Subscriptions and Interactivity URLs to:

```text
https://<your-domain>/api/webhooks/slack
```

### Verify in production

- `GET https://<your-domain>/api/health` succeeds.
- A Slack mention produces a thread reply.
- Queue callback logs show successful processing.

## Common failures

- `401` or signature failures: verify `SLACK_SIGNING_SECRET`.
- No thread processing: confirm queue callback route exists.
- No bot post: verify bot token scopes and Slack app installation.
- Slack timeouts in production: check `vercel.json` queue trigger and callback route path.
- OAuth callback issues for plugins: set `JUNIOR_BASE_URL` to production URL.

## Next step

Now that runtime wiring is done, focus on extension:

- [Plugins Overview](/extend/plugins-overview/)
- [Custom Plugins](/extend/custom-plugins/)
