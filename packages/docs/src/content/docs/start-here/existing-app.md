---
title: Existing App
description: Add Junior runtime routes to an existing Hono or Nitro app.
type: tutorial
summary: Wire Junior into an existing host without losing the supported route and plugin contract.
prerequisites:
  - /reference/handler-surface/
related:
  - /start-here/quickstart/
  - /start-here/slack-app-setup/
  - /reference/config-and-env/
---

Use this path when you already have a Hono or Nitro app and want Junior to own the Slack runtime routes inside it.

The safest integration is still the scaffolded shape: a dedicated server entrypoint that exports the Hono app returned by `createApp()`, plus `juniorNitro()` in Nitro config.

## Add the server entrypoint

Create a Junior server module:

```ts title="server.ts"
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";

const app = await createApp();

export default app;
```

`createApp()` mounts the supported Junior routes listed in [Route & Handler Surface](/reference/handler-surface/).

## Add Nitro wiring

Register `juniorNitro()` so app files and declared plugin packages are copied into the deployment bundle:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  modules: [
    juniorNitro({
      plugins: {
        packages: ["@sentry/junior-sentry"],
      },
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

If your existing app already owns routes, make sure the Junior Hono app still receives the paths under `/api/webhooks`, `/api/oauth/callback`, `/api/internal/turn-resume`, `/api/info`, and `/health`. Do not split those routes across independent runtime instances.

Some packages also export trusted runtime hooks. Register those in `createApp()`;
do not rely on `juniorNitro()` alone. For example, see
[Scheduler Plugin](/extend/scheduler-plugin/) for scheduled tasks and
[GitHub Plugin](/extend/github-plugin/) for the `githubPlugin()` app-code setup.

## Add app files

Junior expects app context and local extension files under `app/`:

```text
app/
├── SOUL.md
├── WORLD.md
├── DESCRIPTION.md
├── skills/
└── plugins/
```

Keep provider setup in plugin manifests and env vars, not in skill prose.

## Verify integration

Run the same checks as a scaffolded app:

```bash
pnpm exec junior check
pnpm dev
curl http://localhost:3000/health
```

Then complete [Slack App Setup](/start-here/slack-app-setup/) and verify one real Slack mention.

## Next step

Review [Config & Environment](/reference/config-and-env/) before deploying, then follow [Deploy to Vercel](/start-here/deploy-to-vercel/).
