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

The scaffolded app is already shaped for Vercel. You link the project, add storage, set env vars, enable OIDC, and point Slack at the production URL. The build does the rest.

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

## Add Redis storage

Junior keeps runtime state, locks, and the sandbox snapshot registry in Redis.
In the same **Storage** tab, create or connect a Redis database. Confirm that
the project has a `REDIS_URL` value for each environment that builds or runs
Junior.

## What each deploy does

You do not run migrations or build snapshots by hand. The scaffolded
`vercel.json` sets the build command, and `pnpm build` runs snapshot warmup:

```json title="vercel.json"
{
  "framework": "nitro",
  "buildCommand": "pnpm exec junior upgrade && pnpm build"
}
```

Each Vercel deploy then:

1. Applies pending core and plugin SQL migrations with
   [junior upgrade](/cli/upgrade/). Applied migrations do not run again.
2. Builds or reuses the sandbox snapshot with
   [junior snapshot create](/cli/snapshot-create/).
3. Builds the app. `juniorNitro()` adds the queue triggers and the heartbeat,
   retention, and auto-archive crons to the build output.

A failed migration or snapshot fails the deploy, so production keeps the last
good release.

Keep `juniorNitro()` in `nitro.config.ts`. `junior check` fails when it is
missing. Do not add `functions["api/internal/agent/continue.ts"]` or Junior
crons to root `vercel.json`; `juniorNitro()` owns them.

One upgrade needs manual steps: a database from before Junior used Drizzle
migrations. Follow the bridge procedure in [junior upgrade](/cli/upgrade/)
before you deploy the new release.

## Configure production environment

Set the core runtime variables in Vercel:

| Variable                                    | Required    | Purpose                                                                                                  |
| ------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`                      | Yes         | Verifies Slack requests.                                                                                 |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes         | Posts replies and calls Slack APIs.                                                                      |
| `REDIS_URL`                                 | Yes         | Queue and runtime state storage.                                                                         |
| `DATABASE_URL`                              | Yes         | Standard Neon/Vercel Postgres URL for Junior SQL records and reporting.                                  |
| `JUNIOR_DATABASE_DRIVER`                    | No          | SQL client driver: `neon` or `postgres`. Defaults to `neon`.                                             |
| `JUNIOR_SQL_STATEMENT_TIMEOUT_MS`           | No          | Runtime PostgreSQL statement timeout. Defaults to `30000`; set `0` to disable.                           |
| `JUNIOR_SECRET`                             | Yes         | Signs internal callbacks and sandbox actor context.                                                      |
| `JUNIOR_ENCRYPTION_KEYS`                    | Yes         | Encrypts stored provider credentials. See [Encryption keys](/reference/config-and-env/#encryption-keys). |
| `CRON_SECRET`                               | Yes         | Authenticates Vercel Cron requests to the internal heartbeat route.                                      |
| `JUNIOR_BASE_URL`                           | Conditional | Main URL for OAuth and callback URLs when Vercel URL values are not enough.                              |
| `JUNIOR_STATE_KEY_PREFIX`                   | No          | Redis key namespace for this deployment when sharing one Redis database.                                 |
| `AI_GATEWAY_API_KEY`                        | Optional    | Fallback AI Gateway auth when OIDC is unavailable. Prefer project OIDC on Vercel.                        |
| `BLOB_STORE_ID`                             | Conditional | Blob store used for durable conversation attachments. Vercel sets this for an OIDC-connected store.      |
| `BLOB_READ_WRITE_TOKEN`                     | Conditional | Static fallback for Blob when OIDC is unavailable. Vercel sets this for a token-connected store.         |
| `VERCEL_SANDBOX_KEEPALIVE_MS`               | Recommended | Extends an active sandbox on each tool acquire. Set to `900000` (15 minutes).                            |

### Configure attachment storage

Junior stores files sent with `sendFiles` as private conversation attachments in
Vercel Blob. The same store also backs `publishImage`, which writes
conversation-owned public artifacts and serves them from
`/public/artifacts/<id>.<ext>`. File delivery and public image publishing fail
if the project has no Blob store credentials.

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

## Enable OIDC for builds

Every build runs `junior snapshot create`, because the base sandbox profile
always has core tools. Enable Vercel OIDC so builds get `VERCEL_OIDC_TOKEN` and
runtime requests get OIDC. OIDC is also the preferred AI Gateway auth path.
Snapshot warmup also reads `REDIS_URL` during the build.

## Point Slack at production

Update these Slack URLs to your production domain:

```text
https://<your-domain>/api/webhooks/slack
```

Apply the URL to:

- Event Subscriptions
- Interactivity

Reinstall the Slack app if scopes changed.

## Verify production

Run these checks after deployment:

1. `GET https://<your-domain>/health` returns `status: "ok"`.
2. A Slack mention produces a thread reply in the expected workspace.
3. `sendFiles` can attach a small test file in Slack.
4. App Home opens without an error.
5. One enabled plugin workflow succeeds end to end.

If a mention gets no reply, check the deployment for the
`/api/internal/heartbeat` cron and the Queue triggers for
`/api/internal/agent/continue` and `/api/internal/plugin/tasks`.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for first-response checks, then monitor production with [Observability](/operate/observability/).
