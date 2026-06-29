---
name: cloudflare
description: Cloudflare production operations via the Cloudflare API MCP server. Use when users ask to investigate Workers errors or performance, check build or deployment status, query logs, inspect DNS records, check load balancer pool health, review Zero Trust tunnels, or manage Cloudflare resources. Do not use for Sentry issues, GitHub/Linear ticketing, or non-Cloudflare infrastructure.
---

# Cloudflare Operations

Use this skill for Cloudflare production operations through Cloudflare's hosted API MCP.

Default to read-only investigation. Cloudflare OAuth or API token scopes are the permission boundary; this plugin cannot allowlist individual Cloudflare API operations inside MCP.

## MCP basics

Cloudflare MCP exposes three tools:

- `docs`: search Cloudflare developer documentation for product behavior and terminology.
- `search`: inspect the current Cloudflare API spec.
- `execute`: call Cloudflare APIs with minimal JavaScript.

Use `docs` when Cloudflare product behavior is unclear. Use `search` before every `execute`; the spec is the source of truth for current methods, paths, parameters, and response shapes. Keep `execute` calls small, scoped, and read-only unless the user has explicitly approved a state-changing change.

## Reference loading

Load references conditionally based on the request:

| Need                                                                                                     | Read                                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Worker errors, failed builds, logs, Logpush, DNS checks, LB health, tunnels                              | [references/workflows.md](references/workflows.md)                                     |
| Any state-changing request: deploy, rollback, DNS, WAF, LB, Access, Logpush, storage, account membership | [references/safety-and-permissions.md](references/safety-and-permissions.md)           |
| Auth failures, permission errors, multiple accounts/zones, rate limits, stale operations                 | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Workflow

1. Classify the request as read-only investigation or state-changing work.
2. Resolve target scope: explicit user account/zone/resource wins; otherwise use `cloudflare.account.id`, `cloudflare.zone.id`, and `cloudflare.worker.name` config where relevant; otherwise discover with MCP and ask one focused question if ambiguous.
3. For any Cloudflare API call, search the MCP API spec first. Do not call Cloudflare API paths from memory or from bundled docs.
4. Keep investigation bounded: last 30 minutes for "right now", last 24 hours for retrospective checks, and recent N builds/deployments unless the user asks for more.
5. Before any state-changing API call, load [references/safety-and-permissions.md](references/safety-and-permissions.md), show current state and the intended change, then wait for explicit approval.
6. Lead with concrete findings, then evidence. Include dashboard links when IDs are available.

## Guardrails

- **Read-first.** Default to investigation. Do not execute writes in response to ambiguous requests like "fix this" or "roll it back" — investigate and propose a plan first.
- **Search owns API selection.** The bundled references give workflows, not API authority.
- **Respect channel defaults.** When a request mentions "the Worker", "our Worker", deploys, builds, logs, or Worker errors without naming a Worker, use `cloudflare.worker.name` as the default Worker target if it is configured.
- **Confirm before writes.** No Worker deploy, rollback, DNS create/update/delete, load balancer change, WAF rule change, Access policy change, or R2/KV/D1 destructive action without explicit user approval after showing current state and change summary.
- **Never delete data by default.** For R2, KV, and D1, support list/inspect/read. Avoid delete/truncate/drop unless the user explicitly asks and confirms.
- **Redact sensitive data.** Do not paste raw log bodies, Worker source, env var values, token values, or authorization headers.
- **Stop on auth failures.** If the MCP server returns an auth error, stop and tell the user. Do not guess at missing permissions.
- **No scope creep.** Operate only on the account/zone/resource the user specified. Do not enumerate or modify resources in other accounts or zones.
