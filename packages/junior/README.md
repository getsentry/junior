# @sentry/junior

`@sentry/junior` is a Slack bot package built on [Hono](https://hono.dev/).

## Install

```bash
pnpm add @sentry/junior hono @sentry/node
```

## Quick usage

`server.ts`:

```ts
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";

const app = await createApp();

export default app;
```

Run `junior init my-bot` to scaffold a complete project including `vercel.json` for Vercel deployment.

Use `juniorNitro({ pluginPackages: [...] })` in `nitro.config.ts` to declare which plugin packages to bundle and load at runtime.

## Full docs

Canonical docs: **https://junior.sentry.dev/**

- Quickstart: https://junior.sentry.dev/start-here/quickstart/
- Deployment: https://junior.sentry.dev/start-here/deploy/
- Plugin setup: https://junior.sentry.dev/extend/plugins-overview/
- API reference: https://junior.sentry.dev/reference/api/
