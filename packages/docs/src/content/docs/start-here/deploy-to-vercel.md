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
    "dev": "nitro dev",
    "build": "junior snapshot create && nitro build"
  }
}
```

Run database migrations before the app build:

```bash
pnpm exec junior upgrade && pnpm build
```

`junior upgrade` applies each core and plugin SQL migration only once. The
`junior snapshot create` command inside `pnpm build` prepares the sandbox
dependencies declared by enabled plugins. Existing pre-Drizzle deployments
must complete the bridge-release procedure below before this build command can
succeed.

For an existing pre-Drizzle deployment, follow the bridge-release drain,
upgrade, verification, and restart procedure in
[junior upgrade](/cli/upgrade/) before promoting the new release.

## Enable Junior's Nitro deployment module

Junior uses a one-minute internal heartbeat to run plugin heartbeats and recover stale agent dispatches. Durable agent work and plugin background tasks are also resumed by Vercel Queue consumers. These pieces are emitted by `juniorNitro()` into Nitro's Vercel Build Output config, which is the config Vercel deploys for Nitro apps.

Keep `juniorNitro()` installed in `nitro.config.ts`:

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

Do not configure `functions["api/internal/agent/continue.ts"]` in root `vercel.json`; Nitro does not deploy that source file as a Vercel function. `juniorNitro()` attaches queue triggers to `/api/internal/agent/continue` and `/api/internal/plugin/tasks` with Nitro `vercel.functionRules`, and emits the `/api/internal/heartbeat` cron into `.vercel/output/config.json`.

The heartbeat endpoint returns `401` unless the incoming Vercel Cron request has a bearer token that matches `CRON_SECRET`.

## Configure production environment

Set the core runtime variables in Vercel:

| Variable                                    | Required    | Purpose                                                                                             |
| ------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`                      | Yes         | Verifies Slack requests.                                                                            |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes         | Posts replies and calls Slack APIs.                                                                 |
| `REDIS_URL`                                 | Yes         | Queue and runtime state storage.                                                                    |
| `DATABASE_URL`                              | Yes         | Standard Neon/Vercel Postgres URL for Junior SQL records and reporting.                             |
| `JUNIOR_DATABASE_DRIVER`                    | No          | SQL client driver: `neon` or `postgres`. Defaults to `neon`.                                        |
| `JUNIOR_SQL_STATEMENT_TIMEOUT_MS`           | No          | Runtime PostgreSQL statement timeout. Defaults to `30000`; set `0` to disable.                      |
| `JUNIOR_SECRET`                             | Yes         | Signs internal callbacks and sandbox actor context.                                                 |
| `CRON_SECRET`                               | Yes         | Authenticates Vercel Cron requests to the internal heartbeat route.                                 |
| `JUNIOR_BASE_URL`                           | Conditional | Main URL for OAuth and callback URLs when Vercel URL values are not enough.                         |
| `JUNIOR_STATE_KEY_PREFIX`                   | No          | Redis key namespace for this deployment when sharing one Redis database.                            |
| `AI_GATEWAY_API_KEY`                        | Optional    | Fallback AI Gateway auth when OIDC is unavailable. Prefer project OIDC on Vercel.                   |
| `BLOB_STORE_ID`                             | Conditional | Blob store used for durable conversation attachments. Vercel sets this for an OIDC-connected store. |
| `BLOB_READ_WRITE_TOKEN`                     | Conditional | Static fallback for Blob when OIDC is unavailable. Vercel sets this for a token-connected store.    |
| `VERCEL_SANDBOX_KEEPALIVE_MS`               | Recommended | Extends an active sandbox on each tool acquire. Set to `900000` (15 minutes).                       |

### Configure attachment storage

Junior stores files sent with `sendFiles` as private conversation attachments in
Vercel Blob. File delivery fails if the project has no Blob store credentials.

1. Open the Vercel project and select **Storage**.
2. Create a **Blob** store with **Private** access.
3. Connect the store to the project for the environments that run Junior.
4. Prefer **OIDC** for production. On an existing token connection, open the
   store's **Projects** tab and select **Upgrade to OIDC** for the project.
5. Redeploy the project after you change the store connection.

An OIDC connection sets `BLOB_STORE_ID`. Vercel also supplies its short-lived
OIDC credential at runtime. The Blob SDK uses these values automatically. A
token connection sets `BLOB_READ_WRITE_TOKEN` instead. Use the static token only
for local development, CI, a non-Vercel host, or when OIDC is not available.

### AI Gateway auth (preferred: project OIDC)

On Vercel, Junior authenticates to AI Gateway with **project OIDC** first so
usage and spend attribute to this project instead of showing as `unknown`.

1. Project Settings → Security → enable **Secure backend access with OIDC
   federation** (Team issuer mode is fine).
2. Do **not** set `AI_GATEWAY_API_KEY` in production unless you need a non-OIDC
   fallback. When both are present, Junior prefers OIDC.
3. For local development without OIDC, either run `vercel link` + `vercel env
pull` or set `AI_GATEWAY_API_KEY`.

`AI_GATEWAY_API_KEY` remains supported for CI and non-Vercel hosts. Team-scoped
keys without a `projectId` will still show as `unknown` in the AI Gateway
projects breakdown.

### Keep active sandboxes alive

Set `VERCEL_SANDBOX_KEEPALIVE_MS=900000` in the Vercel project's **Production** environment. This enables Junior's activity-based keepalive and gives active sandboxes another 15 minutes whenever a sandbox tool is acquired.

Without this variable, keepalive is disabled. Long agent runs that cross model or queue-continuation gaps can then outlive their sandbox session, and Junior may have to create a new sandbox without the previous workspace files.

Configure this through Vercel Project Settings or `vercel env`, not a top-level `env` property in `vercel.json`:

```bash
pnpm dlx vercel@latest env add VERCEL_SANDBOX_KEEPALIVE_MS production
# Enter 900000 when prompted, then redeploy production.
```

Fifteen minutes is the recommended operational default: it covers normal model gaps and tool runtimes without trying to keep pathological long-running commands alive indefinitely. The keepalive runs when Junior acquires a sandbox for tool use; it is not a background timer and cannot revive a sandbox that has already stopped.

Use one stable `JUNIOR_SECRET` per deployment:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Plugin pages list provider-specific env vars such as GitHub App settings or Datadog keys.

Generate `CRON_SECRET` the same way and store it in Vercel for the production environment. Vercel Cron automatically sends it to cron targets as the `Authorization: Bearer <CRON_SECRET>` header.

## Enable snapshot warmup credentials

If enabled plugins need sandbox runtime dependencies, `junior snapshot create` runs during build. In Vercel, enable OIDC so build-time `VERCEL_OIDC_TOKEN` and runtime request OIDC are available. OIDC is also the preferred AI Gateway auth path for project attribution.

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
6. `sendFiles` can attach a small test file in Slack.
7. App Home opens without an error.
8. Queue callback and agent-run logs show successful processing.
9. One enabled plugin workflow succeeds end to end.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for first-response checks, then monitor production with [Observability](/operate/observability/).
