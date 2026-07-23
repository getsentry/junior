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

Want an AI coding agent to handle the setup? Copy the runbook below into Cursor, Claude Code, Copilot, or another agent with terminal access. It scaffolds and deploys the app, then pauses for the steps that require your Vercel and Slack accounts. Credentials stay in those services and should never be pasted into the agent chat.

<details>
<summary>Instructions for your Agent <button title="Copy to clipboard" aria-label="Copy agent instructions" onclick="event.stopPropagation();var c=this.closest('details').querySelector('code');navigator.clipboard.writeText(c.textContent).then(function(){var s=this.querySelector('svg');s.style.stroke='var(--sl-color-green,#16a34a)';setTimeout(function(){s.style.stroke=''},2000)}.bind(this))" style="display:inline-flex;align-items:center;justify-content:center;padding:3px;margin-left:6px;border:none;background:transparent;cursor:pointer;border-radius:4px;vertical-align:middle;opacity:0.75;color:inherit"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="16" height="16" aria-hidden="true"><path d="M3 19a2 2 0 0 1-1-2V2a2 2 0 0 1 1-1h13a2 2 0 0 1 2 1"/><rect x="6" y="5" width="16" height="18" rx="1.5" ry="1.5"/></svg></button></summary>

```text
# Junior production setup — agent runbook

Set up a current Junior app on Vercel. Work phase by phase, verify each success
condition, and stop at every human gate. Never ask the human to paste a secret
or token into chat, and never print secret values.

Inputs:
  APP_NAME="<replace-me>"    # Vercel-safe project name, for example team-junior
  VERCEL_SCOPE=""            # Optional: --scope <team-slug>

Authoritative references:
  https://junior.sentry.dev/cli/init/
  https://junior.sentry.dev/start-here/deploy-to-vercel/
  https://junior.sentry.dev/start-here/slack-app-setup/
  https://junior.sentry.dev/reference/config-and-env/
  https://junior.sentry.dev/start-here/verify-and-troubleshoot/

Rules:
- Stop on a non-zero exit. Report the phase, command, output, and exit code.
- Use the linked Junior docs and each CLI's current --help output. Do not guess
  flags, Marketplace product slugs, generated files, or environment names.
- Do not edit the scaffold unless a documented check shows that it is needed.
- Do not expose credentials in command output, shell tracing, files, or chat.
- Do not continue past a HUMAN GATE until the human confirms it is complete.

## Phase 0 — Preflight

Goal: verify the local tools, Vercel login, and app name.

  node --version
  pnpm --version
  pnpm dlx vercel@latest whoami $VERCEL_SCOPE
  test -n "$APP_NAME" && test "$APP_NAME" != "<replace-me>"

Success:
- Node.js is version 24 or newer and pnpm runs.
- Vercel reports the intended account or team.
- APP_NAME is set to a real name.

## Phase 1 — Scaffold

  pnpm dlx @sentry/junior@latest init "$APP_NAME"
  cd "$APP_NAME"
  pnpm install
  test -f vercel.json
  test -f nitro.config.ts
  test -f server.ts
  test -f plugins.ts
  test -f .env.example
  pnpm typecheck

Success:
- The current initializer creates the project and expected files.
- Dependencies install and TypeScript passes.

## Phase 2 — Link the Vercel project

  pnpm dlx vercel@latest link --yes $VERCEL_SCOPE
  cat .vercel/project.json

Success:
- The linked project name and organization are correct.

## Phase 3 — HUMAN GATE: storage and Vercel project settings

Junior requires Postgres and Redis. The default memory plugin requires Postgres
with pgvector support. Snapshot warmup requires REDIS_URL during the build and
Vercel OIDC enabled. Do not guess Marketplace CLI product slugs.

Stop and ask the human to open the linked Vercel project and complete:
1. Storage: create or connect a Postgres database with pgvector support, such as
   Neon, and expose DATABASE_URL to Production, Preview, and Development.
2. Storage: create or connect Redis and expose REDIS_URL to those environments.
3. Project Settings: enable Vercel OIDC so VERCEL_OIDC_TOKEN is available to
   builds and runtime.
4. Confirm the project has access to an AI model. Add AI_GATEWAY_API_KEY only if
   that Vercel setup requires it.
5. Reply only with confirmation. Do not send connection strings or credentials.

After confirmation, verify names only:

  pnpm dlx vercel@latest env ls production $VERCEL_SCOPE
  pnpm dlx vercel@latest env ls preview $VERCEL_SCOPE
  pnpm dlx vercel@latest env ls development $VERCEL_SCOPE

Success:
- DATABASE_URL and REDIS_URL are listed in all three environments.
- The human confirms OIDC and model access are enabled.

## Phase 4 — Add runtime secrets

Generate stable, independent secrets without printing them, and add them to each
Vercel environment. If Vercel reports an existing value, stop rather than
silently replacing it.

  JUNIOR_SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
  CRON_SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
  for ENV in production preview development; do
    printf '%s' "$JUNIOR_SECRET" | pnpm dlx vercel@latest env add JUNIOR_SECRET "$ENV" $VERCEL_SCOPE
    printf '%s' "$CRON_SECRET" | pnpm dlx vercel@latest env add CRON_SECRET "$ENV" $VERCEL_SCOPE
    printf '%s' '900000' | pnpm dlx vercel@latest env add VERCEL_SANDBOX_KEEPALIVE_MS "$ENV" $VERCEL_SCOPE
  done
  unset JUNIOR_SECRET CRON_SECRET

Success:
- JUNIOR_SECRET, CRON_SECRET, and VERCEL_SANDBOX_KEEPALIVE_MS are listed in all
  three environments. Their values were never printed.

## Phase 5 — First production deploy

Deploy without Slack credentials so the app has a stable public URL. The
scaffolded Vercel build runs Junior's database upgrade before the app build.

  pnpm dlx vercel@latest --prod $VERCEL_SCOPE

Record the production domain shown by Vercel as:
  STABLE_URL="<production-domain-without-trailing-slash>"

Then verify:
  curl -fsS "$STABLE_URL/health"

Success:
- The build, database upgrade, and deployment succeed.
- The health response contains status "ok".
- The URL is public and has no deployment-protection interstitial.

## Phase 6 — HUMAN GATE: create the Slack app and store credentials

Stop and send the human:

  The first Junior deploy is live at <STABLE_URL>.

  Create the Slack app using:
  https://junior.sentry.dev/start-here/slack-app-setup/

  Before configuring Event Subscriptions, Interactivity, or the slash command:
  1. Configure the required bot scopes and install the app to the workspace.
  2. In Vercel, add SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN to Production,
     Preview, and Development for this project.
  3. Reply only with confirmation. Do not paste either credential here.

Do not continue until the human confirms. Then verify that both variable names
are listed, without reading their values:

  pnpm dlx vercel@latest env ls production $VERCEL_SCOPE
  pnpm dlx vercel@latest env ls preview $VERCEL_SCOPE
  pnpm dlx vercel@latest env ls development $VERCEL_SCOPE

Success:
- SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN are listed in all environments.

## Phase 7 — Redeploy with Slack credentials

  pnpm dlx vercel@latest --prod $VERCEL_SCOPE
  curl -fsS "$STABLE_URL/health"

Success:
- The second production deployment succeeds and health remains ok.

## Phase 8 — HUMAN GATE: connect and verify Slack

Stop and ask the human to finish the Slack setup guide using this request URL
for Event Subscriptions, Interactivity, and the configured slash command:

  <STABLE_URL>/api/webhooks/slack

Ask the human to reinstall the app if scopes changed, enable App Home, invite the
bot to a test channel, mention it, and confirm that it reacts and replies in the
same thread. If URL validation or delivery fails, use:
  https://junior.sentry.dev/start-here/verify-and-troubleshoot/

Also verify the Vercel deployment contains:
- the /api/internal/heartbeat cron
- Queue triggers for /api/internal/agent/continue and /api/internal/plugin/tasks

## Done

Report only non-secret results:
- local app directory
- linked Vercel project and production URL
- health result
- heartbeat and Queue trigger result
- Slack reply result
- any optional setup left undone
```

</details>

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
