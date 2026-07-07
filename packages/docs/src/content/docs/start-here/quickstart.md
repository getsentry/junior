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

Want an AI coding agent to handle the full deploy workflow? Copy the runbook below into Cursor, Claude, Copilot, or any agent with terminal access. The runbook does two production deploys: the first brings the app live, the Slack app is created against that live URL, then the second deploy adds Slack credentials. One manual step remains at the gate between those two deploys.

<details>
<summary>Instructions for your Agent <button title="Copy to clipboard" onclick="event.stopPropagation();var c=this.closest('details').querySelector('code');navigator.clipboard.writeText(c.textContent).then(function(){var s=this.querySelector('svg');s.style.stroke='var(--sl-color-green,#16a34a)';setTimeout(function(){s.style.stroke=''},2000)}.bind(this))" style="display:inline-flex;align-items:center;justify-content:center;padding:3px;margin-left:6px;border:none;background:transparent;cursor:pointer;border-radius:4px;vertical-align:middle;opacity:0.75;color:inherit"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="16" height="16" aria-hidden="true"><path d="M3 19a2 2 0 0 1-1-2V2a2 2 0 0 1 1-1h13a2 2 0 0 1 2 1"/><rect x="6" y="5" width="16" height="18" rx="1.5" ry="1.5"/></svg></button></summary>

```text
# Junior deploy runbook — agent instructions

Workflow: scaffold → link → provision storage → generate secrets →
  first deploy → [HUMAN GATE: create Slack app] → redeploy → verify.

Two production deploys. The Slack gate sits between them because Slack
validates webhook URLs against a live endpoint the moment the app is saved.

---

## Inputs

Set both values now. Do not proceed until APP_NAME is replaced.

  APP_NAME="<replace-me>"   # Vercel-safe name, e.g. "my-team-bot"
  VERCEL_SCOPE=""            # Optional. Set to "--scope <team-slug>" if needed.

---

## Rules

- Stop on any non-zero exit code. Report: phase, command, full output, exit code.
- Complete every Success check before moving to the next phase.
- Never guess a CLI product slug, flag, or argument. Use --help, then stop and
  ask if the output is ambiguous.
- At Phase 6: stop completely and send the listed gate message. Do not execute
  any further commands until the human explicitly confirms.

---

## References

  Scaffold CLI        https://junior.sentry.dev/cli/init/
  Deploy to Vercel    https://junior.sentry.dev/start-here/deploy-to-vercel/
  Storage setup       https://junior.sentry.dev/start-here/deploy-to-vercel/#add-postgres-storage
  Config & env vars   https://junior.sentry.dev/reference/config-and-env/
  Slack app setup     https://junior.sentry.dev/start-here/slack-app-setup/
  Verify & debug      https://junior.sentry.dev/start-here/verify-and-troubleshoot/

---

## Phase 0 — Preflight

Goal: Confirm required tools are installed and credentials are ready before
      touching any files.

  node --version && pnpm --version && vercel --version
  vercel whoami
  [ -n "$APP_NAME" ] && [ "$APP_NAME" != "<replace-me>" ] && echo "APP_NAME: $APP_NAME"

Success:
  - All three tools print versions without error.
  - vercel whoami shows an authenticated account.
  - APP_NAME is non-empty and not the literal placeholder <replace-me>.

Stop if: Any tool is missing, Vercel is unauthenticated, APP_NAME is
         empty, or APP_NAME is still <replace-me>.

---

## Phase 1 — Scaffold

Goal: Initialize the Junior app directory and install dependencies.
Ref:  https://junior.sentry.dev/cli/init/

  pnpm dlx @sentry/junior init "$APP_NAME"
  cd "$APP_NAME"
  pnpm install

  ls vercel.json nitro.config.ts server.ts plugins.ts .env.example

Success:
  - All five files exist in the app directory.
  - pnpm install completes without errors.

Stop if: Any listed file is missing or pnpm install fails.

---

## Phase 2 — Link to Vercel

Goal: Link the app directory to a new Vercel project. The --yes flag accepts
      all prompts and uses the directory name as the project name.
Ref:  https://junior.sentry.dev/start-here/deploy-to-vercel/

  vercel link --yes $VERCEL_SCOPE
  cat .vercel/project.json

Success:
  - .vercel/project.json exists.
  - Project name and org match what was intended.

Stop if: vercel link exits non-zero, .vercel/project.json is missing, or the
         project is linked to the wrong scope.

---

## Phase 3 — Provision storage

Goal: Provision Postgres (Neon) and Redis (Upstash) and inject their connection
      URLs into production, preview, and development environments.
Ref:  https://junior.sentry.dev/start-here/deploy-to-vercel/#add-postgres-storage

Step 3a — Postgres:

  vercel install neon --plan free -e production -e preview -e development $VERCEL_SCOPE

  If this is the first time Neon is used on this Vercel team, the CLI may open
  a browser for Marketplace terms acceptance. Complete the flow and re-run.

  vercel env ls production $VERCEL_SCOPE | grep DATABASE_URL

  Success: DATABASE_URL is present in production.
  Stop if: DATABASE_URL is missing after provisioning.

Step 3b — Redis (Upstash):

  Discover the Redis product slug first — do not guess it:

  vercel install upstash --help

  Read the output. Identify the slug for Redis only (not QStash, Search, or
  Vector). Then provision it. For example, if the slug is upstash-redis:

  vercel install upstash-redis --plan free -e production -e preview -e development $VERCEL_SCOPE

  vercel env ls production $VERCEL_SCOPE | grep REDIS_URL

  Success: REDIS_URL is present in production.
  Stop if: The Redis product slug is ambiguous in the help output, or REDIS_URL
           is missing after provisioning.

---

## Phase 4 — Generate secrets

Goal: Create JUNIOR_SECRET and CRON_SECRET in all three Vercel environments.
      These sign internal callbacks and authenticate the heartbeat cron.
Ref:  https://junior.sentry.dev/reference/config-and-env/

  JUNIOR_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
  CRON_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")

  for ENV in production preview development; do
    printf '%s' "$JUNIOR_SECRET" | vercel env add JUNIOR_SECRET "$ENV" $VERCEL_SCOPE
    printf '%s' "$CRON_SECRET"   | vercel env add CRON_SECRET   "$ENV" $VERCEL_SCOPE
  done

  vercel env ls production $VERCEL_SCOPE | grep -E "JUNIOR_SECRET|CRON_SECRET"

Success:
  - Both secrets appear in production, preview, and development.

Stop if: Any env add command fails or reports a conflict.

---

## Phase 5 — First deploy (no Slack credentials yet)

Goal: Deploy to production so the webhook endpoint is publicly reachable before
      the Slack app is created. Slack validates request URLs live on creation.
Ref:  https://junior.sentry.dev/start-here/deploy-to-vercel/

  vercel --prod $VERCEL_SCOPE > /tmp/prod-deploy-url.txt
  cat /tmp/prod-deploy-url.txt

  The deployment URL is printed to stdout. The stable production domain is
  usually visible in the Vercel dashboard under the linked project → Domains.
  Record it as STABLE_URL.

  curl -sf "https://$STABLE_URL/health"

  Expected response: {"status":"ok",...}

Success:
  - Deploy exits 0.
  - /health returns {"status":"ok"}.
  - The URL is publicly reachable without an auth interstitial.

Stop if: Deploy fails, the stable URL cannot be determined, or /health is
         unreachable. Check the dashboard if the URL is unclear.

---

## Phase 6 — HUMAN GATE: Create Slack app

Goal: Pause while the human creates the Slack app using the live production URL.
      Slack validates the webhook URL immediately on app creation, so the first
      deploy must be healthy before this step.
Ref:  https://junior.sentry.dev/start-here/slack-app-setup/

Stop now and send the human this exact message (fill in STABLE_URL):

  ┌───────────────────────────────────────────────────────────────────
  │ Ready for Slack app setup
  │
  │ The first production deploy is live.
  │ Stable URL: https://<STABLE_URL>
  │
  │ Please follow this guide to create the Slack app:
  │ https://junior.sentry.dev/start-here/slack-app-setup/
  │
  │ Use this as the webhook request URL everywhere the guide asks:
  │   https://<STABLE_URL>/api/webhooks/slack
  │
  │ When done, reply with both values on separate lines:
  │   SLACK_SIGNING_SECRET=xsec-...
  │   SLACK_BOT_TOKEN=xoxb-...
  └───────────────────────────────────────────────────────────────────

Do not run any further commands until the human replies with both values.

When the human replies, extract the two values from their reply and assign:

  SLACK_SIGNING_SECRET="<value from human reply>"
  SLACK_BOT_TOKEN="<value from human reply>"

Note: Junior verifies Slack request signatures before handling the
url_verification challenge. If Slack reports URL validation failed, it
may mean the signing secret was not deployed in time. In that case:
  1. Upload SLACK_SIGNING_SECRET now (without SLACK_BOT_TOKEN): run Phase 7
     for SLACK_SIGNING_SECRET only, redeploy, then ask the human to retry
     configuring Event Subscriptions in the Slack app settings.
  2. Once URL validation passes, continue with SLACK_BOT_TOKEN upload.

Verify both are assigned:

  : "${SLACK_SIGNING_SECRET:?SLACK_SIGNING_SECRET is not set}"
  : "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is not set}"

Success:
  - Human provided both values.
  - Both shell variables are non-empty.

Stop if: Either variable is missing, or the human reports that Slack URL
         validation failed and the fallback above did not resolve it.

---

## Phase 7 — Add Slack credentials and redeploy

Goal: Store Slack credentials in Vercel and run the second production deploy.

  for ENV in production preview development; do
    printf '%s' "$SLACK_SIGNING_SECRET" | vercel env add SLACK_SIGNING_SECRET "$ENV" $VERCEL_SCOPE
    printf '%s' "$SLACK_BOT_TOKEN"      | vercel env add SLACK_BOT_TOKEN      "$ENV" $VERCEL_SCOPE
  done

  vercel env ls production $VERCEL_SCOPE | grep -E "SLACK_SIGNING_SECRET|SLACK_BOT_TOKEN"

  vercel --prod $VERCEL_SCOPE

Success:
  - Both credentials exist in production, preview, and development.
  - Second production deploy exits 0.

Stop if: Any env add fails, a conflict is reported, or the deploy fails.

---

## Phase 8 — Verify

Goal: Confirm the bot is healthy, reachable from Slack, and replies to a mention.
Ref:  https://junior.sentry.dev/start-here/verify-and-troubleshoot/

  curl -sf "https://$STABLE_URL/health"

  Expected response: {"status":"ok",...}

Ask the human to run in their Slack workspace:
  1. /invite @<bot-display-name>
  2. Mention the bot in that channel.

Success:
  - /health returns ok after the second deploy.
  - Bot adds a processing reaction and posts a reply in the same thread.

Stop if: /health fails, Slack events are not reaching Vercel, or Vercel logs
         show auth, database, or Redis errors.
         See: https://junior.sentry.dev/start-here/verify-and-troubleshoot/

---

## Done

Report:
  - App directory: $APP_NAME/
  - Vercel project: (from .vercel/project.json)
  - Production URL: https://$STABLE_URL
  - Storage: Neon Postgres (DATABASE_URL) · Upstash Redis (REDIS_URL)
  - Secrets: JUNIOR_SECRET · CRON_SECRET · SLACK_SIGNING_SECRET · SLACK_BOT_TOKEN
  - Health check: pass or fail
  - Slack test: pass or waiting for human
```

</details>

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
| `AI_MODEL`                | No                     | Primary assistant model override.                             |
| `AI_FAST_MODEL`           | No                     | Lightweight routing/classification model override.            |
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
pnpm add @sentry/junior-maintenance @sentry/junior-memory @sentry/junior-agent-browser @sentry/junior-cloudflare @sentry/junior-datadog @sentry/junior-github @sentry/junior-hex @sentry/junior-linear @sentry/junior-notion @sentry/junior-scheduler @sentry/junior-sentry @sentry/junior-vercel
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
