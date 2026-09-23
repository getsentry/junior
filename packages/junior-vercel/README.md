# @sentry/junior-vercel

`@sentry/junior-vercel` adds read-only Vercel deployment and log investigation workflows through the Vercel CLI. Opt-in tools can create, inspect, select, and delete scoped Preview deployments. Signed Vercel webhooks can also notify an existing Junior conversation when a deployment succeeds, fails, or is canceled.

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

Create the conversation watch or event automation before the terminal deployment event. A valid webhook delivery does not create a watch by itself, and unmatched deliveries are not replayed later.

## Auth model

- This package uses a deployment-level Vercel token, not per-user OAuth.
- Junior keeps the real `JUNIOR_VERCEL_TOKEN` host-side.
- Read requests from the CLI and plugin tools receive a host-managed `Authorization` header. Credential hooks reject raw CLI writes.
- Scoped Preview writes use a separate host-only `JUNIOR_VERCEL_PREVIEW_TOKEN`. The hook checks each request before issuing a write credential.
- The sandbox receives only a non-secret placeholder `VERCEL_TOKEN` so the Vercel CLI can run normally before making API requests.

## Optional channel defaults

If a Slack channel usually investigates the same Vercel project or team, store that as a conversation-scoped default:

```bash
jr-rpc config set vercel.project junior-prod
jr-rpc config set vercel.team sentry
```

These defaults are optional fallbacks. If a user names a different project, team, deployment, or URL in a request, Junior should follow the explicit request instead.

## Optional Preview actions

Enable these only after the target project has isolated Preview database,
Redis, storage, and test credentials. A build runs repository code and can run
migrations. These tools do not isolate state or make untrusted commits safe.
Do not put the write token in the Preview deployment or the sandbox.

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

Configure `JUNIOR_VERCEL_TOKEN` for reads and
`JUNIOR_VERCEL_PREVIEW_TOKEN` for writes in the Junior host. Give each the
smallest available Vercel scope. The read token must inspect the configured
project and its deployments. The write token must deploy and assign the alias
there. The plugin enforces the narrower Preview scope even if Vercel grants
broader access. A missing write token does not fall back to the read token.

The options are trusted app configuration, not conversation defaults. Reserve
a dedicated QA hostname outside automatic Production or branch domain
assignment. Do not configure a Production hostname as the QA alias.

- `vercel_preview_create`: build one full GitHub commit SHA in the configured
  project. The source ref is the same SHA, not a moving branch. Project Preview
  settings apply; branch-specific environment overrides are not selected by a
  branch name. Verify the Neon integration gives this API-created deployment an
  isolated database before using it for QA.
- `vercel_preview_select`: assign the configured alias to a READY Preview with
  the expected deployment ID and commit. Reads the alias back after assignment.
- `vercel_preview_inspect`: return state and whether the alias still matches
  the expected deployment ID. If it does not, stop QA and discard affected
  results. This is a point-in-time check, not a lock.
- `vercel_preview_delete`: delete an exact Preview only when requested. It does
  not remove database branches or Redis state.

The tools accept no team, project, repository, alias, environment, or build
setting overrides. The credential hook checks the linked repository and the
request body. Select and delete also re-read deployment scope before issuing
credentials. Production, custom environments, arbitrary aliases, redirects,
and raw CLI writes are rejected. Reads retain their existing provider scope.

These checks do not serialize concurrent testers or changes by Vercel admins.
Moving the alias does not stop older workers or revoke their bot credentials.
There is no automatic alias cleanup. Inspect before retrying an uncertain
create or alias assignment. Never retry a mutation just because its response
was lost.

Slack still needs a reachable, signature-checked webhook at the alias and an
independent test user. Retain dashboard auth when configuring preview
protection. Vercel Preview does not run Vercel Cron. This plugin change does not
provision or modify Slack, databases, project settings, or credentials.

## Read-only CLI scope

The bundled skill limits Junior to:

- `vercel logs`
- `vercel inspect`
- `vercel list` / `vercel ls`
- Vercel CLI help commands

The CLI is for deployment status, build-log, runtime-log, and failed-deployment investigations. Mutations require the opt-in tools above; other writes remain unavailable.

Full setup guide: https://junior.sentry.dev/extend/vercel-plugin/
