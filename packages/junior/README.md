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

Use `juniorNitro({ plugins: { packages: [...] } })` in `nitro.config.ts` to declare which plugin packages to bundle and load at runtime. Packages with trusted runtime hooks, such as `@sentry/junior-github`, also need to be registered in app code with `createApp({ plugins: [...] })`.

## Full docs

Canonical docs: **https://junior.sentry.dev/**

- Quickstart: https://junior.sentry.dev/start-here/quickstart/
- Slack app setup: https://junior.sentry.dev/start-here/slack-app-setup/
- Deployment: https://junior.sentry.dev/start-here/deploy-to-vercel/
- Plugin setup: https://junior.sentry.dev/extend/
- API reference: https://junior.sentry.dev/reference/api/
