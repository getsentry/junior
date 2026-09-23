---
name: vercel
description: Deploy and inspect Vercel apps, assign aliases, delete deployments, investigate logs, and monitor deployment outcomes. Use for Vercel deployment operations and QA setup through the plugin tools or Vercel CLI. Do not use for GitHub code changes or other cloud providers.
---

# Vercel Operations

Use the existing host-managed Vercel credential. Actions go through normal
runtime review. Never work around a denied action with another command or API.

## Resolve the target

- Use the user's explicit project, team, deployment, alias, and environment.
- Read `vercel.project` and `vercel.team` with standalone `jr-rpc config get`
  commands only when those defaults are needed. They are fallbacks, not limits.
- Do not change defaults unless requested.
- Resolve an ambiguous mutation target before acting. Preview is the deployment
  default; use Production when the user requests it.

## Tools and CLI

Discover tools in the Vercel catalog and follow their schemas:

- `vercel_deployment_create`: deploy a Git ref from the project's linked GitHub
  repository. Pass a full `commitSha` to pin the source while retaining branch
  context in `ref`. The project supplies build settings and credentials.
- `vercel_deployment_inspect`: inspect a deployment ID or hostname.
- `vercel_alias_assign`: point an alias hostname at an exact deployment ID.
  This can replace live traffic. Read back the result; do not overwrite another
  selection automatically if `matches` is false.
- `vercel_alias_inspect`: read an alias's current deployment ID or redirect.
- `vercel_deployment_delete`: delete the exact deployment the user requests.
  Deletion does not remove its database or Redis state.
- `vercel_deployment`: resolve a resource for a watch or event automation.

Prefer these tools when they cover the action. Use the CLI for logs, local
source uploads, other Git providers, or other requested Vercel operations.
Inspect `vercel <command> --help` when the command shape is unclear. Use
`--scope <team>` and explicit targets to avoid ambient project mistakes.
Do not set, print, copy, or request tokens; authentication is host-managed.

## Verification and failures

- Record the deployment ID, source commit when available, and environment.
  A successful create starts a build; it does not mean the deployment is ready.
- Inspect before retrying an uncertain write. A timeout can occur after Vercel
  accepted it. Do not blindly repeat a deploy, alias assignment, or deletion.
- For QA, compare alias deployment IDs before and after testing. A changed
  target makes affected results inconclusive. This is not a lock and cannot
  detect every change between reads. Moving an alias does not stop old workers.
- Builds can run migrations and use environment credentials. Verify isolated
  state before QA that must not affect shared data. Alias and health checks do
  not prove Slack QA passed.
- Report missing credentials or provider permission failures. Do not guess
  permission scopes or change credentials as a workaround.
- Retry a transient read once. Bound waits and report unresolved failures.

## Logs and watches

- Prefer `vercel logs` with a project, time window, and limit. Default to the
  last hour for current incidents and the last 24 hours for retrospective work.
- Use `vercel inspect <deployment> --logs` for build logs and `vercel list
<project>` for deployment discovery. Quote only decisive diagnostics; logs
  can contain private data.
- Use live log streaming only when requested and stop after collecting evidence.
- For watches, call `vercel_deployment` with project and optional team, target,
  and full commit SHA. Use its returned resource. A commit defaults to
  Production unless `target` is supplied. Create the watch before completion;
  earlier webhook events are not replayed.
