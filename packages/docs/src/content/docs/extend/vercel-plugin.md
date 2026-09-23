---
title: Vercel Plugin
description: Configure Vercel investigations, scoped Preview actions, and deployment events.
type: tutorial
summary: Let Junior inspect Vercel deployments and receive signed deployment outcomes in Slack.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/watches/
  - /operate/security-hardening/
  - /operate/sandbox-snapshots/
---

Use the Vercel plugin to inspect deployments, fetch build logs, search runtime
logs, and respond to deployment outcomes through watches and
event automations.

The plugin is read-only by default. Its runtime registration installs the CLI
and injects host-managed Vercel API auth. CLI use stays limited to
`vercel logs`, `vercel inspect`, `vercel list`, and help commands. Optional
host tools can manage Preview deployments in one configured project.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-vercel
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { vercelPlugin } from "@sentry/junior-vercel";

export const plugins = defineJuniorPlugins([vercelPlugin()]);
```

Register `vercelPlugin()` so Junior loads the webhook route.

## Config

Set conversation config with `jr-rpc config set`, or define the same keys for every conversation with `createApp({ configDefaults })`. Set deployment variables in the Junior environment, then redeploy. Explicit values in a request always win over conversation defaults.

### Conversation defaults

<details class="plugin-config">
<summary><code>vercel.project</code></summary>

Default Vercel project for investigations and deployment watches when a request does not name one.

- **Define:** `jr-rpc config set vercel.project <project>`
- **Install-wide default:** `configDefaults["vercel.project"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>vercel.team</code></summary>

Default Vercel team slug or ID used to resolve projects.

- **Define:** `jr-rpc config set vercel.team <team>`
- **Install-wide default:** `configDefaults["vercel.team"]`
- **Required:** No
- **Environment override:** None

</details>

### Environment variables

<details class="plugin-config">
<summary><code>JUNIOR_VERCEL_TOKEN</code></summary>

Host-managed access token for deployment and log inspection.

- **Define:** Set `JUNIOR_VERCEL_TOKEN` in the deployment environment
- **Required:** Yes
- **Environment override:** `JUNIOR_VERCEL_TOKEN`

Create a [Vercel access token](https://vercel.com/account/tokens) scoped to the projects and teams users need to inspect.

</details>

<details class="plugin-config">
<summary><code>VERCEL_WEBHOOK_SECRET</code></summary>

Account webhook secret used to verify deployment events.

- **Define:** Set `VERCEL_WEBHOOK_SECRET` in the deployment environment
- **Required:** Yes for events; otherwise no
- **Environment override:** `VERCEL_WEBHOOK_SECRET`

</details>

## Set up deployment webhooks

Webhook monitoring is optional. It uses a
[Vercel account webhook](https://vercel.com/docs/webhooks#account-webhooks)
scoped to the projects Junior should monitor. Account webhooks are available for
Pro and Enterprise teams.

1. Open **Team Settings**, then **Webhooks**, and create an account webhook.
2. Select **Deployment Succeeded**, **Deployment Error**, and **Deployment
   Cancelled**.
3. Select only the projects Junior should monitor.
4. Enter `https://<your-domain>/api/webhooks/vercel` as the endpoint URL. It
   must be publicly reachable over HTTPS; do not place it behind interactive
   login or deployment protection that blocks Vercel's request.
5. Create the webhook and copy the displayed secret. Vercel shows this secret
   only once.
6. Set `VERCEL_WEBHOOK_SECRET` in Junior's Production environment, then
   redeploy.

Junior verifies Vercel's `x-vercel-signature` against the untouched request body
before accepting a delivery.

## Watches

Set `VERCEL_WEBHOOK_SECRET` to enable watches. See
[Watches](/concepts/watches/) for the difference between temporary watches
and durable event automations.

Deployment watches use Vercel's project ID. Users can give a project name or
ID. Junior gets the project ID from Vercel's authenticated project API.
Include the team slug or ID when projects with the same name may exist in more
than one account.

### `deployment`

One Vercel project, optionally limited to a target or one commit. Identifier:

`<project-id>[:preview|production|staging][:full-commit-sha]`

- `<project-id>` watches every deployment for the project.
- `<project-id>:production` watches every production deployment.
- `<project-id>:production:<sha>` watches one production deployment for that
  commit.

<details class="event">
<summary><code>deployment.succeeded</code></summary>

The deployment completed successfully.

</details>

<details class="event">
<summary><code>deployment.error</code></summary>

The deployment failed.

</details>

<details class="event">
<summary><code>deployment.canceled</code></summary>

The deployment was canceled.

</details>

Create the watch or event automation before the deployment finishes. Junior does
not replay earlier webhooks. Project- and target-scoped watches keep
receiving later deployments; commit-scoped watches complete on the terminal
event.

## Auth model

- The plugin uses host-configured Vercel tokens, not per-user OAuth. Reads use
  `JUNIOR_VERCEL_TOKEN`; opt-in writes use `JUNIOR_VERCEL_PREVIEW_TOKEN`.
- Junior keeps the real `JUNIOR_VERCEL_TOKEN` value host-side.
- Matching Vercel API requests from the CLI and plugin tools receive a
  host-managed `Authorization` header.
- The sandbox receives only a non-secret placeholder `VERCEL_TOKEN` so the
  Vercel CLI can perform its normal auth checks before making requests.
- Users do not connect or disconnect individual Vercel accounts from Junior App
  Home for this plugin.
- `VERCEL_WEBHOOK_SECRET` verifies webhook deliveries and is independent of the
  API token.

## Capabilities

Once configured, Junior can:

- Search recent runtime logs for a project, environment, deployment, status
  code, level, source, or query string
- Inspect production or preview deployment failures
- Fetch build logs for a deployment ID or URL
- List recent deployments for a project
- Find deployments by status, environment, production flag, or Git commit SHA
  metadata
- Stream live logs briefly when a user explicitly asks for live output
- Subscribe an existing Slack conversation to every deployment for a project,
  every deployment for one target, or one commit-scoped deployment when webhooks
  are enabled

## Verify

Confirm Junior can query Vercel successfully:

1. Ask Junior a Vercel question in a channel, for example: `Show production error logs for junior-prod from the last hour.`
2. Confirm the thread returns a bounded summary with the project, environment,
   time window, and filters used.
3. Confirm Junior does not run CLI mutation commands. Only the configured
   Preview tools can write; Production deploys, env edits, and unrelated domain
   changes stay blocked.

If deployment webhooks are enabled, also verify one signed delivery:

1. Ask Junior: `Whenever production deployments fail for junior-prod, tell me in this channel.`
2. Ask Junior to list the active event automations or watches in the same conversation
   and confirm the Vercel project ID, optional `production` target, and event
   types are correct.
3. Trigger a matching deployment.
4. In **Team Settings → Webhooks**, open the delivery and confirm the endpoint
   returned `202` with `Accepted` when the response body is shown.
5. Confirm Junior posts the terminal outcome in the original conversation.

## Optional Preview actions

Pass a `preview` scope to `vercelPlugin` in trusted app configuration:

```ts
vercelPlugin({
  preview: {
    teamId: "team_example",
    projectId: "prj_example",
    repository: "getsentry/junior",
    alias: "junior-slack-qa.sentry.dev",
  },
});
```

Set `JUNIOR_VERCEL_PREVIEW_TOKEN` on the Junior host with the smallest available
Vercel write scope. Keep `JUNIOR_VERCEL_TOKEN` for reads and scope verification.
Never expose the write token to the sandbox or the Preview being tested.

The tools create an exact-commit GitHub Preview, inspect its state and alias,
select the configured alias, or delete a requested Preview. They cannot deploy
to Production or override environment and build settings. Credential hooks
check each write; raw CLI writes remain blocked. Conversation defaults cannot
change the configured scope.

Before enabling these actions, configure isolated Preview database, Redis,
storage, and test credentials. A build runs repository code and can run
migrations. The API source ref is the full SHA, not a branch name. Verify that
your Neon integration isolates these deployments. Use a dedicated alias that
is not assigned automatically to Production or a Git branch.

Alias checks are not a lock. Inspect before and after each QA group and stop if
`aliasMatches` is false. There is no automatic alias restore or deletion.
Moving an alias does not stop old workers. These tools do not configure Slack,
provide a browser test identity, or run Vercel Cron on Previews.

## Failure modes

- `JUNIOR_VERCEL_TOKEN` missing: add it to the Junior deployment environment and
  redeploy.
- `401 Unauthorized`: the token is invalid, expired, revoked, or not being
  injected for Vercel API requests.
- `403 Forbidden` or `permission denied`: the token lacks permission to read the
  requested project, deployment, or logs.
- Project not found: confirm the project name, `vercel.project`, and
  `vercel.team` defaults.
- Empty logs: confirm the environment, deployment, branch, and time window
  before widening the search.
- Long-running live logs: live streaming is only for explicit user requests and
  should be stopped once enough evidence is captured.
- Missing Preview tools: configure the `preview` scope and redeploy Junior.
- Preview writes unavailable: configure `JUNIOR_VERCEL_PREVIEW_TOKEN` on the host.
  Other mutations, including Production deploys and env edits, remain blocked.
- Junior does not offer a deployment watch: configure `VERCEL_WEBHOOK_SECRET`
  and `SLACK_BOT_TOKEN`, redeploy, and provide a project name or configure
  `vercel.project` for the conversation. Multi-workspace Slack OAuth mode does
  not support event delivery yet.
- Webhook delivery returns `401`: the Vercel account webhook secret does not
  match `VERCEL_WEBHOOK_SECRET`, or the request lacks `x-vercel-signature`.
- Webhook delivery returns `202 Ignored`: the signed event is unsupported or
  does not contain a valid project ID, deployment ID, and production, staging,
  or null-preview target.
- Webhook delivery cannot reach Junior: confirm the endpoint uses the production
  Junior domain and is not blocked by deployment protection, login, or another
  access-control layer.
- Vercel accepts the webhook but no Slack update appears: confirm the original
  conversation still has an active watch or event automation for the same
  project, optional target, optional commit SHA, and event type.

## Next step

Review [Watches](/concepts/watches/) and
[Sandbox Snapshots](/operate/sandbox-snapshots/).
