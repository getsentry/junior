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

Use a Vercel service account or token with the smallest project/team access that covers the projects and actions users need. The same token handles reads and writes. No second token or Preview scope configuration is required.

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

`vercelPlugin()` registers these general tools without extra options:

- `vercel_deployment_create`: deploy a branch, tag, or commit from an existing
  project's linked GitHub repository. Preview is the default; Production is an
  explicit target. An optional full commit SHA pins the source while preserving
  branch context for Vercel integrations.
- `vercel_deployment_inspect`: inspect an ID or hostname and return deployment
  identity, state, environment, and source when available.
- `vercel_alias_assign`: assign a hostname to an exact deployment ID and read
  back the alias. `matches` is false if it no longer points at that deployment.
- `vercel_alias_inspect`: return the alias's deployment ID or redirect.
- `vercel_deployment_delete`: delete an exact deployment ID when requested.

The tools accept explicit team and resource targets. Channel defaults are
fallbacks, not project restrictions. All actions use the existing host-managed
`JUNIOR_VERCEL_TOKEN` and normal runtime review, including Guardian. The plugin
does not add a second approval system or change Guardian configuration.
Vercel permissions still apply.

Tools return selected fields, not full deployment records that may contain
secrets. Creates start a build; inspect readiness before using the deployment.
Check provider state before retrying a write whose response was lost.

## CLI operations

Prefer tools for the operations above. Use the Vercel CLI for logs, local source
uploads, non-GitHub sources, or other requested Vercel operations. Inspect CLI
help for the command shape and use explicit project/team targets. Do not use a
CLI call to bypass a tool denial. Credentials remain host-managed.

## QA use

QA setup supplies the project and alias; they are not plugin restrictions.
Compare the alias's deployment ID before and after a test. These checks are
point-in-time observations, not locks. They do not stop old workers or prove
which build handled a delayed event. Do not automatically restore an alias or
delete a deployment another tester may be using.

Builds inherit project environment credentials and may run migrations. Verify
isolated database, Redis, and storage state before testing changes that must not
affect shared state. This plugin does not provision those resources or a Slack
test-user session. Preview deployments do not run Vercel Cron.

Full setup guide: https://junior.sentry.dev/extend/vercel-plugin/
