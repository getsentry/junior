---
title: Vercel Plugin
description: Configure Vercel deployments, aliases, investigations, and deployment events.
type: tutorial
summary: Let Junior deploy apps, manage aliases, investigate logs, and receive deployment outcomes in Slack.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/watches/
  - /operate/security-hardening/
  - /operate/sandbox-snapshots/
---

Use the Vercel plugin to deploy apps, manage aliases, investigate logs, and
respond to deployment outcomes through watches and event automations.
The plugin provides tools and installs the Vercel CLI. Both use one host-managed
token and normal Guardian review.

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

Host-managed access token for Vercel operations, including reads and writes.

- **Define:** Set `JUNIOR_VERCEL_TOKEN` in the deployment environment
- **Required:** Yes
- **Environment override:** `JUNIOR_VERCEL_TOKEN`

Create a [Vercel access token](https://vercel.com/account/tokens) with access to the projects, teams, and actions users need.

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

- The plugin uses a single Vercel access token configured at deploy time, not
  per-user OAuth.
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
3. Verify a requested Preview deployment on a test project and inspect its
   deployment ID and state. Confirm mutations still pass normal runtime review.

If deployment webhooks are enabled, also verify one signed delivery:

1. Ask Junior: `Whenever production deployments fail for junior-prod, tell me in this channel.`
2. Ask Junior to list the active event automations or watches in the same conversation
   and confirm the Vercel project ID, optional `production` target, and event
   types are correct.
3. Trigger a matching deployment.
4. In **Team Settings → Webhooks**, open the delivery and confirm the endpoint
   returned `202` with `Accepted` when the response body is shown.
5. Confirm Junior posts the terminal outcome in the original conversation.

## Deployment and alias tools

These tools are available with `vercelPlugin()` and the existing token:

- `vercel_deployment_create`: supply a project, Git ref, optional team, and
  optional full commit SHA. It uses the project's linked GitHub repository.
  Preview is the default target; Production must be selected explicitly.
- `vercel_deployment_inspect`: inspect an exact deployment ID or hostname.
- `vercel_alias_assign`: assign an alias hostname to a deployment ID, then read
  back the target. It can replace live traffic.
- `vercel_alias_inspect`: read the alias's current deployment ID or redirect.
- `vercel_deployment_delete`: delete the exact deployment the user requests.

Use the CLI for logs, local source uploads, and other Git providers.
A create starts a build; inspect its state before use. If a response is lost,
inspect Vercel state before retrying a write.

Alias checks can detect changed targets but are not locks. Moving an alias does
not stop older workers. Deployments inherit build settings and credentials and
can run migrations. Use isolated state for QA that must not affect shared data.

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
- Mutation denied: respect the runtime review or Vercel permission result. Do
  not retry through another command to bypass it.
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
