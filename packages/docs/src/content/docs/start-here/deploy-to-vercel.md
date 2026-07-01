---
title: Deploy to Vercel
description: Deploy a scaffolded Junior app to Vercel and verify production Slack delivery.
type: tutorial
summary: Configure Vercel build, env vars, Slack URLs, and production verification for Junior.
prerequisites:
  - /start-here/quickstart/
  - /start-here/slack-app-setup/
related:
  - /reference/config-and-env/
  - /operate/observability/
  - /start-here/verify-and-troubleshoot/
---

The scaffolded app is already shaped for Vercel. Deployment mainly means linking the project, keeping `juniorNitro()` in Nitro config, setting env vars, enabling snapshot warmup support, and pointing Slack at the production URL.

## Link the project

Authenticate and link the local app to a Vercel project:

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest link
```

If your account requires a team scope, pass the same `--scope <team-slug>` value to Vercel commands.

## Add Postgres storage

New Junior installs expect a SQL database for upgrade migrations and reporting.
After the project is linked, create one from the Vercel dashboard:

1. Open the Vercel project.
2. Select **Storage**.
3. Select **Create Database**.
4. Choose a Postgres provider such as **Neon**.
5. Accept the default database settings and connect it to the project.

Vercel Marketplace storage providers inject database credentials into the
project environment. For Neon and other Postgres providers, confirm the project
has a `DATABASE_URL` value before the first production deploy.

## Configure build command

The scaffolded `package.json` includes the production build script:

```json title="package.json"
{
  "scripts": {
    "check": "junior check",
    "dev": "vite dev",
    "build": "junior snapshot create && vite build"
  }
}
```

New scaffolded apps run Junior upgrades before the normal build:

```bash
pnpm exec junior upgrade && pnpm build
```

Keep that Vercel build command. Older installs should configure Junior's SQL database before enabling `junior upgrade`. `junior snapshot create` prepares sandbox runtime dependencies declared by enabled plugins before request handling starts. `junior upgrade` applies schema and state migrations before the new deployment serves traffic.

## Enable Junior's Nitro deployment module

Junior uses a one-minute internal heartbeat to run plugin heartbeats and recover stale agent dispatches. Durable agent work and plugin background tasks are also resumed by Vercel Queue consumers. These pieces are emitted by `juniorNitro()` into Nitro's Vercel Build Output config, which is the config Vercel deploys for Nitro apps.

Keep `juniorNitro()` installed in `nitro.config.ts`:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [juniorNitro()],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

Do not configure `functions["api/internal/agent/continue.ts"]` in root `vercel.json`; Nitro does not deploy that source file as a Vercel function. `juniorNitro()` attaches queue triggers to `/api/internal/agent/continue` and `/api/internal/plugin/tasks` with Nitro `vercel.functionRules`, and emits the `/api/internal/heartbeat` cron into `.vercel/output/config.json`.

The heartbeat endpoint returns `401` unless the incoming Vercel Cron request has a bearer token that matches `CRON_SECRET`.

## Configure production environment

Set the core runtime variables in Vercel:

| Variable                                    | Required    | Purpose                                                                        |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `SLACK_SIGNING_SECRET`                      | Yes         | Verifies Slack requests.                                                       |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes         | Posts replies and calls Slack APIs.                                            |
| `REDIS_URL`                                 | Yes         | Queue and runtime state storage.                                               |
| `DATABASE_URL`                              | Yes         | Standard Neon/Vercel Postgres URL for Junior SQL records and reporting.        |
| `JUNIOR_DATABASE_DRIVER`                    | No          | SQL client driver: `neon` or `postgres`. Defaults to `neon`.                   |
| `JUNIOR_SECRET`                             | Yes         | Signs internal callbacks and sandbox requester context.                        |
| `CRON_SECRET`                               | Yes         | Authenticates Vercel Cron requests to the internal heartbeat route.            |
| `JUNIOR_BASE_URL`                           | Conditional | Canonical URL for OAuth and callback URLs when Vercel URL envs are not enough. |
| `JUNIOR_STATE_KEY_PREFIX`                   | No          | Redis key namespace for this deployment when sharing one Redis database.       |
| `AI_GATEWAY_API_KEY`                        | Optional    | AI Gateway auth when your setup requires it.                                   |

Use one stable `JUNIOR_SECRET` per deployment:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Plugin pages list provider-specific env vars such as GitHub App settings or Datadog keys.

Generate `CRON_SECRET` the same way and store it in Vercel for the production environment. Vercel Cron automatically sends it to cron targets as the `Authorization: Bearer <CRON_SECRET>` header.

## Enable snapshot warmup credentials

If enabled plugins need sandbox runtime dependencies, `junior snapshot create` runs during build. In Vercel, enable OIDC so `VERCEL_OIDC_TOKEN` is available during the build.

Snapshot warmup also needs `REDIS_URL` during build because the snapshot registry is Redis-backed.

## Point Slack at production

Update these Slack URLs to your production domain:

```text
https://<your-domain>/api/webhooks/slack
```

Apply the URL to:

- Event Subscriptions
- Interactivity
- Slash command configured by `JUNIOR_SLASH_COMMAND` (defaults to `/jr`)

Reinstall the Slack app if scopes changed.

## Verify production

Run these checks after deployment:

1. `GET https://<your-domain>/health` returns `status: "ok"`.
2. `junior check` passes without deployment config errors.
3. The Vercel deployment has a cron entry for `/api/internal/heartbeat`.
4. The Vercel deployment has Queue triggers for `/api/internal/agent/continue` and `/api/internal/plugin/tasks`.
5. A Slack mention produces a thread reply in the expected workspace.
6. App Home opens without an error.
7. Queue callback and agent-run logs show successful processing.
8. One enabled plugin workflow succeeds end to end.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for first-response checks, then monitor production with [Observability](/operate/observability/).
