# @sentry/junior-vercel

`@sentry/junior-vercel` adds read-only Vercel deployment and log investigation workflows to Junior through the Vercel CLI.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-vercel
```

## Configure

List the plugin in `juniorNitro({ plugins: { packages: [...] } })`:

```ts
juniorNitro({
  plugins: {
    packages: ["@sentry/junior-vercel"],
  },
});
```

Set a Vercel token in the Junior deployment environment:

```bash
JUNIOR_VERCEL_TOKEN=...
```

Use a Vercel service account or token with the smallest project/team access that covers the deployments users need to inspect.

## Auth model

- This package uses a deployment-level Vercel token, not per-user OAuth.
- Junior keeps the real `JUNIOR_VERCEL_TOKEN` host-side.
- Matching Vercel API requests from the CLI receive a host-managed `Authorization` header.
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
