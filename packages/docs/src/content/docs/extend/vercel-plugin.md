---
title: Vercel Plugin
description: Configure read-only Vercel investigations and deployment outcome webhooks.
type: tutorial
summary: Let Junior inspect Vercel deployments and receive signed deployment outcomes in Slack.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
  - /operate/sandbox-snapshots/
---

The Vercel plugin installs the Vercel CLI so Slack users can ask Junior to inspect deployments, fetch build logs, search runtime logs, and find deployments by project, environment, status, or commit metadata. An optional signed webhook can return terminal deployment outcomes to the conversation that requested them.

Junior keeps this plugin read-only. Its runtime registration installs the CLI and injects host-managed Vercel API auth, while the bundled skill limits Junior to `vercel logs`, `vercel inspect`, `vercel list`, and CLI help commands.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-vercel
```

## Runtime setup

Add the plugin factory to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { vercelPlugin } from "@sentry/junior-vercel";

export const plugins = defineJuniorPlugins([vercelPlugin()]);
```

Point `juniorNitro()` at that plugin module:

```ts title="nitro.config.ts"
juniorNitro({ plugins: "./plugins" });
```

Set a Vercel token in your Junior deployment environment:

```bash
JUNIOR_VERCEL_TOKEN=...
```

Create a [Vercel access token](https://vercel.com/account/tokens) scoped to the projects and teams users need to inspect.

## Configure deployment webhooks

Webhook monitoring is optional. It uses a [Vercel account webhook](https://vercel.com/docs/webhooks#account-webhooks) scoped to the projects Junior should monitor instead of creating a Vercel webhook for each conversation. Account webhooks are available for Pro and Enterprise teams.

Create the webhook from the Vercel team that owns the projects:

1. Open **Team Settings**, then **Webhooks**, and create an account webhook.
2. Select **Deployment Succeeded**, **Deployment Error**, and **Deployment Cancelled**.
3. Select only the projects Junior should monitor.
4. Enter `https://<your-domain>/api/webhooks/vercel` as the endpoint URL. It must be publicly reachable over HTTPS; do not place it behind interactive login or deployment protection that blocks Vercel's request.
5. Create the webhook and copy the displayed secret. Vercel shows this secret only once.
6. Add the secret to the Junior app's Production environment as a sensitive value, then redeploy Junior:

```bash
VERCEL_WEBHOOK_SECRET=...
```

The selected events correspond to `deployment.succeeded`, `deployment.error`, and `deployment.canceled`. Junior verifies Vercel's `x-vercel-signature` against the untouched request body before accepting a delivery.

Deployment watches match Vercel's canonical `prj_...` project ID. Users can name a project or supply its ID; Junior resolves the canonical ID through Vercel's authenticated project API. Include the team slug or ID when projects with the same name may exist in more than one account.

The webhook payload must contain a deployment ID, a production or staging target (or Vercel's `null` preview target), and a full Git commit SHA. Deployments without Git commit metadata are accepted by the endpoint but cannot match a watch.

Configuring the account webhook does not create a conversation watch. Ask Junior to monitor the deployment before its terminal event occurs; unmatched webhook deliveries are not replayed into subscriptions created later.

## Optional channel defaults

If a Slack channel usually investigates the same Vercel project or team, store that as a conversation-scoped default:

```bash
jr-rpc config set vercel.project junior-prod
jr-rpc config set vercel.team sentry
```

These defaults are optional fallbacks for both investigations and deployment watches. Junior resolves the remembered project name to its canonical ID when creating a watch. If a user names a different project, team, deployment, or URL in a request, Junior follows the explicit request instead.

## Auth model

- The plugin uses a single Vercel access token configured at deploy time, not per-user OAuth.
- Junior keeps the real `JUNIOR_VERCEL_TOKEN` value host-side.
- Matching Vercel API requests from the CLI and plugin tools receive a host-managed `Authorization` header.
- The sandbox receives only a non-secret placeholder `VERCEL_TOKEN` so the Vercel CLI can perform its normal auth checks before making requests.
- Users do not connect or disconnect individual Vercel accounts from Junior App Home for this plugin.
- `VERCEL_WEBHOOK_SECRET` verifies webhook deliveries and is independent of the API token.

## What users can do

- Search recent runtime logs for a project, environment, deployment, status code, level, source, or query string.
- Inspect production or preview deployment failures.
- Fetch build logs for a deployment ID or URL.
- List recent deployments for a project.
- Find deployments by status, environment, production flag, or Git commit SHA metadata.
- Stream live logs briefly when a user explicitly asks for live output.
- Subscribe an existing Slack conversation to the success, error, or cancellation of a deployment identified by project, target, and commit SHA.

## Verify

Confirm Junior can query Vercel successfully:

1. Ask Junior a Vercel question in a channel, for example: `Show production error logs for junior-prod from the last hour.`
2. Confirm the thread returns a bounded summary with the project, environment, time window, and filters used.
3. Confirm Junior does not run mutation commands for requests such as deploys, rollbacks, env changes, cache purges, or domain changes.

If deployment webhooks are enabled, also verify one signed delivery:

1. After the final commit SHA is known, ask Junior: `Watch the production deployment for junior-prod at commit <40-character SHA> and tell me when it finishes.`
2. Ask Junior to list the active watches in the same conversation and confirm the Vercel project ID, `production` target, commit SHA, and event types are correct.
3. Trigger the deployment for that exact project and commit.
4. In **Team Settings → Webhooks**, open the delivery and confirm the endpoint returned `202` with `Accepted` when the response body is shown.
5. Confirm Junior posts the terminal outcome in the original conversation.

## Failure modes

- `JUNIOR_VERCEL_TOKEN` missing: add it to the Junior deployment environment and redeploy.
- `401 Unauthorized`: the token is invalid, expired, revoked, or not being injected for Vercel API requests.
- `403 Forbidden` or `permission denied`: the token lacks permission to read the requested project, deployment, or logs.
- Project not found: confirm the project name, `vercel.project`, and `vercel.team` defaults.
- Empty logs: confirm the environment, deployment, branch, and time window before widening the search.
- Long-running live logs: live streaming is only for explicit user requests and should be stopped once enough evidence is captured.
- Mutation requests: the plugin is read-only and the skill will decline these.
- Junior does not offer a deployment watch: configure `VERCEL_WEBHOOK_SECRET`, redeploy, and provide a project name or configure `vercel.project` for the conversation.
- Webhook delivery returns `401`: the Vercel account webhook secret does not match `VERCEL_WEBHOOK_SECRET`, or the request lacks `x-vercel-signature`.
- Webhook delivery returns `202 Ignored`: the signed event is unsupported or does not contain a valid project ID, deployment ID, target, and full Git commit SHA.
- Webhook delivery cannot reach Junior: confirm the endpoint uses the production Junior domain and is not blocked by deployment protection, login, or another access-control layer.
- Vercel accepts the webhook but no Slack update appears: confirm the original conversation still has an active subscription for the same project, target, commit SHA, and event type.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Sandbox Snapshots](/operate/sandbox-snapshots/) to understand how plugin credentials and CLI dependencies are delivered at runtime.
