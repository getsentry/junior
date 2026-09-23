---
name: vercel
description: Deploy and inspect Vercel apps, assign aliases, delete deployments, investigate logs, and monitor deployment outcomes. Use for Vercel deployment and log requests, not GitHub code changes or other cloud providers.
---

# Vercel Operations

## Resolve the target

- Use the user's explicit project, team, deployment, alias, and environment.
- Read `vercel.project` and `vercel.team` with standalone `jr-rpc config get`
  commands only when those defaults are needed. They are fallbacks, not limits.
- Do not change defaults unless requested.
- Resolve an ambiguous target before a write. Use Production only when requested.

## Tools and CLI

Discover deployment and alias tools in the Vercel catalog. Follow their schemas.
Use the CLI for logs, local source uploads, other Git providers, or operations
not covered by tools. Inspect `vercel <command> --help` when needed. Use
`--scope <team>` and explicit targets.

Authentication is host-managed. Do not set, print, copy, or request tokens.
Never use another command or API to bypass a denied action.

## Verification and failures

- Record the deployment ID, source commit when available, and environment.
  Inspect readiness before using a new deployment.
- Inspect before retrying an uncertain write. A timeout can occur after Vercel
  accepted it. Do not blindly repeat a deploy, alias assignment, or deletion.
- For QA, compare alias deployment IDs before and after testing. A changed
  target makes affected results inconclusive. Alias checks are not locks.
  If an assignment returns `matches=false`, do not overwrite the changed target.
- Verify isolated state before QA that must not affect shared data. Builds can
  run migrations. Moving an alias does not stop older workers.
- Report missing credentials or provider permission failures. Do not guess
  permission scopes or change credentials as a workaround.
- Retry a transient read once. Bound waits and report unresolved failures.

## Logs and watches

- Prefer `vercel logs` with a project, time window, and limit. Default to the
  last hour for current incidents and the last 24 hours for retrospective work.
- Use `vercel inspect <deployment> --logs` for build logs and
  `vercel list <project>` for deployment discovery. Quote only decisive
  diagnostics; logs can contain private data.
- Use live log streaming only when requested and stop after collecting evidence.
- For watches, call `vercel_deployment` with project and optional team, target,
  and full commit SHA. Use its returned resource. A commit defaults to
  Production unless `target` is supplied. Create the watch before completion;
  earlier webhook events are not replayed.
