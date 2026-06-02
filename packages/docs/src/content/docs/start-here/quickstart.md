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

## Prerequisites

Use the same baseline that the scaffolded CI workflow uses:

- Node.js 24
- pnpm
- A Redis URL for queue and state storage

Slack credentials are needed before the bot can reply in Slack. You can scaffold and verify the local health route first, then finish [Slack App Setup](/start-here/slack-app-setup/).

## Create a new app

Run the initializer in an empty target directory:

```bash
pnpm dlx @sentry/junior init my-bot
cd my-bot
pnpm install
```

`junior init` creates the app entrypoint, Nitro/Vite config, Vercel config, CI workflow, app context files, local plugin and skill directories, and `.env.example`.

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

| Variable                  | Required               | Purpose                                                        |
| ------------------------- | ---------------------- | -------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`    | Yes, for Slack traffic | Verifies Slack requests.                                       |
| `SLACK_BOT_TOKEN`         | Yes, for Slack replies | Posts thread replies and calls Slack APIs.                     |
| `REDIS_URL`               | Yes                    | Queue and runtime state storage.                               |
| `JUNIOR_SECRET`           | Yes                    | Signs internal resume callbacks and sandbox requester context. |
| `JUNIOR_BOT_NAME`         | No                     | Bot display/config name.                                       |
| `AI_MODEL`                | No                     | Primary assistant model override.                              |
| `AI_FAST_MODEL`           | No                     | Lightweight routing/classification model override.             |
| `AI_VISION_MODEL`         | No                     | Enables image understanding when set.                          |
| `AI_WEB_SEARCH_MODEL`     | No                     | Search model override.                                         |
| `JUNIOR_STATE_KEY_PREFIX` | No                     | Redis key namespace for this local app/environment.            |

See [Config & Environment](/reference/config-and-env/) for the full reference.

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

Packaged plugins must be installed and listed in `juniorNitro` so Nitro bundles their manifests, skills, and runtime dependencies.

Install only the plugins you plan to enable:

```bash
pnpm add @sentry/junior-agent-browser @sentry/junior-datadog @sentry/junior-github @sentry/junior-hex @sentry/junior-linear @sentry/junior-notion @sentry/junior-scheduler @sentry/junior-sentry @sentry/junior-vercel
```

Then list them in `nitro.config.ts`:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: {
        packages: [
          "@sentry/junior-agent-browser",
          "@sentry/junior-datadog",
          "@sentry/junior-github",
          "@sentry/junior-hex",
          "@sentry/junior-linear",
          "@sentry/junior-notion",
          "@sentry/junior-scheduler",
          "@sentry/junior-sentry",
          "@sentry/junior-vercel",
        ],
      },
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

Run the app check after changing plugins or skills:

```bash
pnpm check
```

Plugins with trusted runtime hooks need one more app-code registration step.
For example, `@sentry/junior-scheduler` must be registered with
`schedulerPlugin()` inside `createApp()` to enable scheduled tasks, and
`@sentry/junior-github` must be registered with `githubPlugin()` to enforce Git
commit attribution. See [Scheduler Plugin](/extend/scheduler-plugin/) and
[GitHub Plugin](/extend/github-plugin/) for those setups.

## Verify plugin content

When enabled plugins declare sandbox runtime dependencies, the scaffolded build runs snapshot warmup:

```json title="package.json"
{
  "scripts": {
    "check": "junior check",
    "dev": "vite dev",
    "build": "junior snapshot create && vite build"
  }
}
```

Run `pnpm check` before `pnpm build` so manifest and skill issues fail early.

## Next step

Finish [Slack App Setup](/start-here/slack-app-setup/) so the bot can receive events, then follow [Deploy to Vercel](/start-here/deploy-to-vercel/) for production.
