# @sentry/junior

`@sentry/junior` is a Slack bot package built on [Hono](https://hono.dev/).

## Install

```bash
pnpm add @sentry/junior hono @sentry/node
```

## Quick usage

`plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins([]);
```

`server.ts`:

```ts
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";
import { plugins } from "./plugins.ts";

const app = await createApp({
  plugins,
});

export default app;
```

Run `junior init my-bot` to scaffold a complete project including `vercel.json` for Vercel deployment.

Use `defineJuniorPlugins([...])` in a runtime-safe plugin module, then point
`juniorNitro({ plugins: "./plugins" })` at that module and pass the same set to
`createApp({ plugins })`. Manifest-only packages use package-name strings;
factories such as `githubPlugin()` register their manifest and in-process hooks
together.

## Full docs

Canonical docs: **https://junior.sentry.dev/**

- Quickstart: https://junior.sentry.dev/start-here/quickstart/
- Slack app setup: https://junior.sentry.dev/start-here/slack-app-setup/
- Deployment: https://junior.sentry.dev/start-here/deploy-to-vercel/
- Plugin setup: https://junior.sentry.dev/extend/
