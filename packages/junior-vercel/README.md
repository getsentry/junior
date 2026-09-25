# @sentry/junior-vercel

`@sentry/junior-vercel` adds Vercel deployment and alias tools, plus CLI workflows for deployment and log investigation. Signed Vercel webhooks can also notify an existing Junior conversation when a deployment succeeds, fails, or is canceled.

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

Use a Vercel service account or token with access to the required projects and actions. The same token handles reads and writes.

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

Create the conversation watch or event automation before the terminal deployment event. A valid webhook delivery does not create a watch by itself, and unmatched deliveries are not replayed later.

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

## Deployment and alias tools

`vercelPlugin()` registers:

- `vercel_deploymentCreate`: deploy a branch, tag, or commit from an existing
  project's linked GitHub repository. Preview is the default; Production is an
  explicit target. An optional full commit SHA pins the source while preserving
  branch context for Vercel integrations.
- `vercel_deploymentInspect`: inspect an ID or hostname and return deployment
  identity, state, environment, and source when available.
- `vercel_aliasAssign`: assign a hostname to an exact deployment ID and read
  back the alias. `matches` is false if it no longer points at that deployment.
- `vercel_aliasInspect`: return the alias's deployment ID or redirect.
- `vercel_deploymentDelete`: delete an exact deployment ID when requested.

Tools use the host-managed token and normal Guardian review. Vercel permissions
still apply.

Tools return selected fields, not full deployment records that may contain
secrets. Creates start a build; inspect readiness before using the deployment.
Check provider state before retrying a write whose response was lost.

Use the Vercel CLI for logs, local source uploads, and other operations not
covered by the tools.

## Limits

Alias checks are not locks. Moving an alias does not stop older workers or
identify which build handled a delayed event. Builds inherit project settings
and credentials and may run migrations. The plugin does not isolate databases
or other state. Preview deployments do not run Vercel Cron.

Full setup guide: https://junior.sentry.dev/extend/vercel-plugin/
