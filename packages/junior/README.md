# @sentry/junior

`@sentry/junior` is a Slack bot package built on [Hono](https://hono.dev/).

## Install

```bash
pnpm add @sentry/junior hono @sentry/node
```

## Quick usage

`api/index.ts`:

```ts
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";
import { handle } from "hono/vercel";

export default handle(
  createApp({
    pluginPackages: [
      "@sentry/junior-github",
      "@sentry/junior-notion",
      "@sentry/junior-sentry",
    ],
  }),
);
```

`vercel.json`:

```json
{
  "functions": {
    "api/index.ts": {
      "maxDuration": 800,
      "includeFiles": ["app/**/*"]
    }
  },
  "rewrites": [{ "source": "/api/(.*)", "destination": "/api" }]
}
```

## Full docs

Canonical docs: **https://junior.sentry.dev/**

- Quickstart: https://junior.sentry.dev/start-here/quickstart/
- Deployment: https://junior.sentry.dev/start-here/deploy/
- Plugin setup: https://junior.sentry.dev/extend/plugins-overview/
- API reference: https://junior.sentry.dev/reference/api/
