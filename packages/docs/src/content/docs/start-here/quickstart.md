---
title: Quickstart
description: Start from `junior init`, verify locally, then add the few deployment-specific pieces needed for Vercel.
type: tutorial
summary: Scaffold a new Junior app with `junior init`, fill in environment and Slack setup, then deploy the same runtime to Vercel.
prerequisites: []
related:
  - /extend/
  - /start-here/verify-and-troubleshoot/
---

## Prerequisites

- Node.js 20+
- pnpm
- A Slack app with signing secret + bot token
- Redis URL
- A Vercel account

## Create a new app

Start with the initializer. This is the default path for a new project.

```bash
npx @sentry/junior init my-bot
cd my-bot
pnpm install
```

`junior init` already creates the core runtime wiring for you:

- `api/index.ts`
- `vercel.json`
- `app/data/SOUL.md` and `app/data/ABOUT.md`
- `app/skills/` and `app/plugins/`
- `.env.example`

For a new app, you usually do not need to hand-create routes or runtime wrapper files.

## Configure environment

Copy values into your local env file. The scaffold includes `.env.example` with the core runtime variables.

Required:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `REDIS_URL`

Recommended:

- `JUNIOR_BOT_NAME`
- `AI_MODEL`
- `AI_FAST_MODEL`

See [Config & Environment](/reference/config-and-env/) for the full reference.

## Run locally

```bash
pnpm dev
```

## Verify locally

Check the health route first, then verify a real Slack thread.

- `GET http://localhost:3000/api/health` returns JSON with `status: "ok"`.
- Set your Slack Event Subscriptions and Interactivity URLs to `http://<your-tunnel-or-dev-host>/api/webhooks/slack`.
- Mention the bot in Slack and confirm it replies in the same thread.

## Add plugins

The initializer creates local `app/plugins` and `app/skills` directories, so you can start there without extra runtime config.

If you want to use npm-distributed plugins, install them explicitly:

```bash
pnpm add @sentry/junior-github @sentry/junior-notion
```

Then register them in `api/index.ts`:

```ts title="api/index.ts"
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";
import { handle } from "hono/vercel";

export default handle(
  createApp({
    pluginPackages: ["@sentry/junior-github", "@sentry/junior-notion"],
  }),
);
```

See [Plugins](/extend/) for the local-vs-package model.

## What `junior init` created

If you need to wire Junior into an existing app, this is what `junior init` creates.

### API entry point

```ts title="api/index.ts"
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";
import { handle } from "hono/vercel";

export default handle(createApp());
```

### Vercel config

```json title="vercel.json"
{
  "functions": {
    "api/index.ts": {
      "maxDuration": 800,
      "includeFiles": "app/**"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
}
```

## Deploy to Vercel

`junior init` does not configure your Vercel project. You still need to add the deploy-specific pieces below.

### Link the project

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest link
```

### Add queue trigger

Add the queue trigger to your `vercel.json`:

```json title="vercel.json"
{
  "functions": {
    "api/index.ts": {
      "maxDuration": 800,
      "includeFiles": "app/**"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
}
```

### Configure build command

Set the Vercel build command to run snapshot warmup after app build.

```json title="package.json"
{
  "scripts": {
    "build": "junior snapshot create"
  }
}
```

### Configure production environment

Required:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN` (or `SLACK_BOT_USER_TOKEN`)
- `REDIS_URL`

Also required for build-time snapshot warmup:

- Vercel OIDC enabled so `VERCEL_OIDC_TOKEN` is available during build

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
- No thread processing: confirm the API handler and queue trigger are configured.
- No bot post: verify bot token scopes and Slack app installation.
- Slack timeouts in production: check `vercel.json` queue trigger and function config.
- OAuth callback issues for plugins: set `JUNIOR_BASE_URL` to production URL.
- Snapshot warmup build failures: verify `REDIS_URL` is available to builds and OIDC is enabled for `VERCEL_OIDC_TOKEN`.

## Next step

Now that the scaffold is running, move to [Plugins](/extend/) to add packaged or local extensions, then use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for post-deploy checks.
