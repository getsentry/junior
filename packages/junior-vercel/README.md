# @sentry/junior-vercel

`@sentry/junior-vercel` adds read-only Vercel deployment and log investigation workflows through the Vercel CLI. Signed Vercel webhooks can also notify an existing Junior conversation when a deployment succeeds, fails, or is canceled.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-vercel
```

## Configure

Add the plugin factory to the plugin set exported from `plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { vercelPlugin } from "@sentry/junior-vercel";

export const plugins = defineJuniorPlugins([vercelPlugin()]);
```

Point `juniorNitro()` at that plugin module:

```ts
juniorNitro({ plugins: "./plugins" });
```

Set a Vercel token in the Junior deployment environment:

```bash
JUNIOR_VERCEL_TOKEN=...
```

Use a Vercel service account or token with the smallest project/team access that covers the deployments users need to inspect.

## Optional deployment webhooks

In **Vercel Team Settings → Webhooks**, create a project-scoped [account webhook](https://vercel.com/docs/webhooks#account-webhooks). Account webhooks are available for Pro and Enterprise teams.

```text
https://<junior-host>/api/webhooks/vercel
```

The endpoint must be publicly reachable. Subscribe it to `deployment.succeeded`, `deployment.error`, and `deployment.canceled`, select the projects Junior should monitor, and save the one-time secret as a sensitive `VERCEL_WEBHOOK_SECRET` value in Junior's Production environment. Redeploy Junior after adding it.

Deployment watches use Vercel's project ID. Junior resolves that ID from the project name or ID and optional team slug or ID through Vercel's authenticated project API.

Supported scopes (`deployment` resource type):

- `<project-id>` for every deployment in the project
- `<project-id>:production` for every production deployment
- `<project-id>:production:<sha>` for one commit-scoped deployment

Create the conversation watch or event task before the terminal deployment event. A valid webhook delivery does not create a watch by itself, and unmatched deliveries are not replayed later.

## Auth model

- This package uses a deployment-level Vercel token, not per-user OAuth.
- Junior keeps the real `JUNIOR_VERCEL_TOKEN` host-side.
- Matching Vercel API requests from the CLI and plugin tools receive a host-managed `Authorization` header.
- The sandbox receives only a non-secret placeholder `VERCEL_TOKEN` so the Vercel CLI can run normally before making API requests.

## Optional channel defaults

If a Slack channel usually investigates the same Vercel project or team, store that as a conversation-scoped default:

```bash
jr-rpc config set vercel.project junior-prod
jr-rpc config set vercel.team sentry
```

These defaults are optional fallbacks. If a user names a different project, team, deployment, or URL in a request, Junior should follow the explicit request instead.

## Read-only scope

The bundled skill limits Junior to:

- `vercel logs`
- `vercel inspect`
- `vercel list` / `vercel ls`
- Vercel CLI help commands

It is intended for deployment status, build-log, runtime-log, and failed-deployment investigations. It is not for deploys, rollbacks, env vars, domains, caches, storage, aliases, or other Vercel mutations.

Full setup guide: https://junior.sentry.dev/extend/vercel-plugin/
