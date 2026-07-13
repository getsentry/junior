---
title: Quickstart
description: Create a Junior app, run it locally, and verify the runtime before adding Slack or plugins.
type: tutorial
summary: Scaffold a Junior app and confirm the local runtime is healthy.
prerequisites: []
related:
  - /start-here/slack-app-setup/
  - /start-here/deploy-to-vercel/
  - /extend/
---

Start here when you want a new Junior app that follows the supported Hono, Nitro, and Vercel shape.

For production setup, complete [Deploy to Vercel](/start-here/deploy-to-vercel/) and [Slack App Setup](/start-here/slack-app-setup/). Keep the manual Slack app creation step between the first live deployment and the deployment that adds Slack credentials.

## Prerequisites

Use the same baseline that the scaffolded CI workflow uses:

- Node.js 24
- pnpm
- A Postgres database for Junior SQL records and the default memory plugin
- A Redis URL for runtime state, locks, and durable task records

Slack credentials are needed before the bot can reply in Slack. You can scaffold and verify the local health route first, then finish [Slack App Setup](/start-here/slack-app-setup/).

## Create a new app

Run the initializer in an empty target directory:

```bash
pnpm dlx @sentry/junior init my-bot
cd my-bot
pnpm install
```

`junior init` creates the app entrypoint, Nitro config, Vercel config, TypeScript config, CI workflow, app context files, local plugin and skill directories, `.env.example`, and a `plugins.ts` with maintenance and memory enabled by default.

The generated `app/` files have separate jobs:

| File                 | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `app/SOUL.md`        | Assistant voice and behavior.                         |
| `app/WORLD.md`       | Operational context and domain knowledge.             |
| `app/DESCRIPTION.md` | User-facing app description.                          |
| `app/skills/`        | Local skills that are not owned by a plugin.          |
| `app/plugins/`       | App-local plugin manifests and bundled plugin skills. |

Do not recreate the old `ABOUT.md`; use `WORLD.md` and `DESCRIPTION.md`.

## Configure environment

Copy `.env.example` to your local environment file, then generate one stable `JUNIOR_SECRET`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set these values before running real turns:

| Variable                  | Required               | Purpose                                                       |
| ------------------------- | ---------------------- | ------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`    | Yes, for Slack traffic | Verifies Slack requests.                                      |
| `SLACK_BOT_TOKEN`         | Yes, for Slack replies | Posts thread replies and calls Slack APIs.                    |
| `DATABASE_URL`            | Yes                    | Postgres connection string for Junior SQL records and memory. |
| `JUNIOR_DATABASE_DRIVER`  | No                     | SQL client driver: `neon` or `postgres`.                      |
| `REDIS_URL`               | Yes                    | Runtime state, locks, and durable background task records.    |
| `JUNIOR_SECRET`           | Yes                    | Signs internal resume callbacks and sandbox actor context.    |
| `JUNIOR_BOT_NAME`         | No                     | Bot display/config name.                                      |
| `JUNIOR_SLASH_COMMAND`    | No                     | Slack slash command name. Defaults to `/jr`.                  |
| `AI_MODEL`                | No                     | Standard main-agent model override.                           |
| `AI_FAST_MODEL`           | No                     | Lightweight routing/classification model override.            |
| `AI_HANDOFF_MODEL`        | No                     | Model for the default `handoff` profile.                      |
| `AI_MODEL_PROFILES`       | No                     | JSON map of additional named handoff profiles.                |
| `AI_EMBEDDING_MODEL`      | No                     | Embedding model override for plugin vector retrieval.         |
| `AI_VISION_MODEL`         | No                     | Enables image understanding when set.                         |
| `AI_WEB_SEARCH_MODEL`     | No                     | Search model override.                                        |
| `JUNIOR_STATE_KEY_PREFIX` | No                     | Redis key namespace for this local app/environment.           |

See [Config & Environment](/reference/config-and-env/) for the full reference.
If you keep the default memory plugin enabled, use a Postgres database with
pgvector support before running migrations. Local Postgres URLs automatically
use the `postgres` driver; set `JUNIOR_DATABASE_DRIVER=postgres` for other
non-Neon Postgres providers.

## Run locally

Start the local dev server:

```bash
pnpm dev
```

The app listens on `http://localhost:3000` by default.

## Verify locally

Check the health route before wiring Slack:

```bash
curl http://localhost:3000/health
```

The response should include `status: "ok"`.

After you complete [Slack App Setup](/start-here/slack-app-setup/), point Slack at your tunnel URL and mention the bot in a thread. The reply should appear in the same thread.

## Add packaged plugins

New apps created with `junior init` already have a `plugins.ts` file with maintenance and memory enabled. To add more packaged plugins, install the packages and add them to the existing plugin set.

For an existing app created without a `plugins.ts`, create one as shown below.

Install only the plugins you plan to enable. If you are creating `plugins.ts`
for an existing app, include the default maintenance and memory packages too:

```bash
pnpm add @sentry/junior-maintenance @sentry/junior-memory @sentry/junior-agent-browser @sentry/junior-amplitude @sentry/junior-cloudflare @sentry/junior-datadog @sentry/junior-github @sentry/junior-hex @sentry/junior-linear @sentry/junior-notion @sentry/junior-scheduler @sentry/junior-sentry @sentry/junior-vercel
```

Add them to the plugin set in `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { createMemoryPlugin } from "@sentry/junior-memory";
import { githubPlugin } from "@sentry/junior-github";
import { schedulerPlugin } from "@sentry/junior-scheduler";

export const plugins = defineJuniorPlugins([
  createMemoryPlugin(),
  "@sentry/junior-maintenance",
  "@sentry/junior-agent-browser",
  "@sentry/junior-amplitude",
  "@sentry/junior-cloudflare",
  "@sentry/junior-datadog",
  githubPlugin({
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
  "@sentry/junior-hex",
  "@sentry/junior-linear",
  "@sentry/junior-notion",
  schedulerPlugin(),
  "@sentry/junior-sentry",
  "@sentry/junior-vercel",
]);
```

Point `juniorNitro()` at that module and pass the same plugin set to
`createApp()` so local dev and built bundles use identical runtime plugins:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

```ts title="server.ts"
import { createApp } from "@sentry/junior";
import { plugins } from "./plugins.ts";

const app = await createApp({
  plugins,
});

export default app;
```

Run the app check after changing plugins or skills:

```bash
pnpm check
```

The runtime-safe plugin set is also where runtime hooks are registered.
`schedulerPlugin()` enables scheduled task tools and heartbeat behavior, and
`githubPlugin()` enforces Git commit attribution. See
[Scheduler Plugin](/extend/scheduler-plugin/) and
[GitHub Plugin](/extend/github-plugin/) for those setups.

## Verify plugin content

When enabled plugins declare sandbox runtime dependencies, the scaffolded build runs snapshot warmup:

```json title="package.json"
{
  "scripts": {
    "check": "junior check",
    "dev": "nitro dev",
    "build": "junior snapshot create && nitro build"
  }
}
```

Run `pnpm check` before `pnpm build` so manifest and skill issues fail early.

## Next step

Finish [Slack App Setup](/start-here/slack-app-setup/) so the bot can receive events, then follow [Deploy to Vercel](/start-here/deploy-to-vercel/) for production.
