---
title: Vercel Plugin
description: Configure the Vercel CLI for read-only deployment and log investigations.
type: tutorial
summary: Let Junior inspect Vercel deployments, build logs, and runtime logs from Slack.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
  - /operate/sandbox-snapshots/
---

The Vercel plugin installs the Vercel CLI so Slack users can ask Junior to inspect deployments, fetch build logs, search runtime logs, and find deployments by project, environment, status, or commit metadata.

Junior keeps this plugin read-only. The packaged manifest installs the CLI and injects host-managed Vercel API auth, while the bundled skill limits Junior to `vercel logs`, `vercel inspect`, `vercel list`, and CLI help commands.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-vercel
```

## Runtime setup

List the plugin in `juniorNitro({ plugins: { packages: [...] } })`:

```ts title="nitro.config.ts"
juniorNitro({
  plugins: {
    packages: ["@sentry/junior-vercel"],
  },
});
```

Set a Vercel token in your Junior deployment environment:

```bash
JUNIOR_VERCEL_TOKEN=...
```

Use a Vercel service account or token with the smallest project/team access that covers the deployments users need to inspect. Vercel API permissions are still evolving, so the plugin's read-only boundary comes from the command allowlist plus least-privilege account setup.

## Optional channel defaults

If a Slack channel usually investigates the same Vercel project or team, store that as a conversation-scoped default:

```bash
jr-rpc config set vercel.project junior-prod
jr-rpc config set vercel.team sentry
```

These defaults are optional fallbacks. If a user names a different project, team, deployment, or URL in a request, Junior follows the explicit request instead.

## Auth model

- The plugin uses a deployment-level Vercel token, not per-user OAuth.
- Junior keeps the real `JUNIOR_VERCEL_TOKEN` value host-side.
- Matching Vercel API requests from the CLI receive a host-managed `Authorization` header.
- The sandbox receives only a non-secret placeholder `VERCEL_TOKEN` so the Vercel CLI can perform its normal auth checks before making requests.
- Users do not connect or disconnect individual Vercel accounts from Junior App Home for this plugin.

## What users can do

- Search recent runtime logs for a project, environment, deployment, status code, level, source, or query string.
- Inspect production or preview deployment failures.
- Fetch build logs for a deployment ID or URL.
- List recent deployments for a project.
- Find deployments by status, environment, production flag, or Git commit SHA metadata.
- Stream live logs briefly when a user explicitly asks for live output.

## Verify

Confirm Junior can query Vercel successfully:

1. Ask Junior a Vercel question in a channel, for example: `Show production error logs for junior-prod from the last hour.`
2. Confirm the thread returns a bounded summary with the project, environment, time window, and filters used.
3. Confirm Junior does not run mutation commands for requests such as deploys, rollbacks, env changes, cache purges, or domain changes.

## Failure modes

- `JUNIOR_VERCEL_TOKEN` missing: add it to the Junior deployment environment and redeploy.
- `401 Unauthorized`: the token is invalid, expired, revoked, or not being injected for Vercel API requests.
- `403 Forbidden` or `permission denied`: the token or service account cannot read the requested project, deployment, or logs.
- Project not found: confirm the project name, `vercel.project`, and `vercel.team` defaults.
- Empty logs: confirm the environment, deployment, branch, and time window before widening the search.
- Long-running live logs: live streaming is only for explicit user requests and should be stopped once enough evidence is captured.
- Mutation requests: the plugin is read-only and the skill will decline these.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Sandbox Snapshots](/operate/sandbox-snapshots/) to understand how plugin credentials and CLI dependencies are delivered at runtime.
