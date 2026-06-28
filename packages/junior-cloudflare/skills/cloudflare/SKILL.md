---
name: cloudflare
description: Cloudflare production operations via the Cloudflare API MCP server. Use when users ask to investigate Workers errors or performance, check build or deployment status, query logs, inspect DNS records, check load balancer pool health, review Zero Trust tunnels, or manage Cloudflare resources. Do not use for Sentry issues, GitHub/Linear ticketing, or non-Cloudflare infrastructure.
---

# Cloudflare Operations

Use this skill for Cloudflare production operations via the Cloudflare API MCP server.

The MCP server exposes the full Cloudflare API (~2,500 endpoints) through a code-mode pattern: write minimal JavaScript to search the API spec, then execute calls against the Cloudflare API.

## Reference loading

Load references conditionally based on the request:

| Need                                                          | Read                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Any Cloudflare operation                                      | [references/api-surface.md](references/api-surface.md)                                 |
| Common prod ops tasks (Worker errors, builds, DNS, LB health) | [references/common-use-cases.md](references/common-use-cases.md)                       |
| Permission errors, account discovery, MCP failures            | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |
| Writes, rollbacks, DNS changes, destructive actions           | [references/safety-and-permissions.md](references/safety-and-permissions.md)           |

## Workflow

### 1. Resolve the operation and target

- Determine whether the request is read-only inspection, deployment/rollback, DNS change, log investigation, build status, or other write.
- Prefer explicit account IDs, zone names, Worker script names, build IDs, or Cloudflare URLs when the user provides them.
- When the user did not specify scope, treat `cloudflare.account-id` and `cloudflare.zone-id` conversation config as optional defaults. Explicit user input always wins over config.
- Only set or change `cloudflare.account-id` and `cloudflare.zone-id` when the user explicitly asks to store a default for this conversation or channel.
- If the request refers to a prior Cloudflare resource indirectly, inspect the current thread for account IDs, zone names, Worker names, ray IDs, or build IDs before asking the user to restate them.
- Ask one focused follow-up only when the request cannot proceed without missing information that the thread does not supply.

### 2. Discover account and zone IDs when not configured

- Validate the token and list accounts: use `search` to find `/user/tokens/verify` and `/accounts` endpoints, then `execute` to call them.
- When the user provides a zone name (e.g. `example.com`), resolve it with `/zones?name=<zone>` rather than assuming an ID.
- When `cloudflare.account-id` is configured, use it directly. Do not re-fetch unless the config is wrong.
- Auto-detection works when the token has Account Resources: Read. If it fails, ask the user for the account ID.

### 3. Use the code-mode MCP tools

The MCP server exposes three tools:

- **`search`** — writes JavaScript against the Cloudflare API spec to find matching endpoints. Use this first to confirm the correct endpoint path and method.
- **`execute`** — writes JavaScript that calls `cloudflare.request()` with the discovered endpoint. This makes real API calls.
- **`docs`** — searches Cloudflare developer documentation. Use to clarify concepts, compatibility dates, product behavior, or flag naming.

**Always search before executing.** Do not guess endpoint paths. Use `search` to confirm the exact endpoint, required parameters, and response schema before calling `execute`.

**Bound every query:**

- For logs and analytics: default to the last 30 minutes for "right now" questions, last 24 hours for retrospective questions. Name the assumed window in the response.
- For Worker script lists or zone lists: cap results at a reasonable page size; do not page through thousands of results unless the user asks.
- For builds and deployments: start with the most recent N items.

**Keep execute code minimal:**

- Print only the fields relevant to the answer. Do not dump full API responses.
- Do not include or print secrets, tokens, Worker source code, environment variable values, or raw authorization headers.
- Paginate deliberately; do not fetch more than necessary.

### 4. For investigation requests (default mode)

- Start read-only. Use `search` + `execute` to inspect current state.
- Report concrete findings first: error counts, deployment version, build status, DNS record values, pool health status.
- Include Cloudflare dashboard deep links when you have resource IDs. Construct them as `https://dash.cloudflare.com/<account_id>/...`.
- Keep routine tool steps silent. Do not narrate every search and execute call.

### 5. For write requests (deploy, rollback, DNS, config changes)

**Stop and confirm before any write.**

Before executing any state-changing API call:

1. Identify the exact resource (account ID, zone ID, script name, record ID, pool ID, etc.).
2. Fetch and display the current state.
3. State the intended API endpoint, method, and what will change.
4. Show a concise before/after summary or diff.
5. Ask for explicit user approval.
6. After approval, execute the write and verify the result.

See [references/safety-and-permissions.md](references/safety-and-permissions.md) for the full list of write operations requiring confirmation.

### 6. Report results

- Lead with the answer (status, count, version, health) then evidence.
- Include resource IDs and Cloudflare dashboard links when available.
- Redact secrets, tokens, env var values, cookie headers, authorization headers, and Worker source code. Summarize patterns, include small representative samples.
- State assumed time windows. Flag when data may be delayed (analytics pipelines can lag by a few minutes).
- For incomplete results (pagination cutoff, log retention limit, plan restriction), say so explicitly.

## Guardrails

- **Read-first.** Default to investigation. Do not execute writes in response to ambiguous requests like "fix this" or "roll it back" — investigate and propose a plan first.
- **Confirm before writes.** No Worker deploy, rollback, DNS create/update/delete, load balancer change, WAF rule change, Access policy change, or R2/KV/D1 destructive action without explicit user approval after showing current state and change summary.
- **Never delete data by default.** For R2, KV, and D1, support list/inspect/read. Avoid delete/truncate/drop unless the user explicitly asks and confirms.
- **Redact sensitive data.** Do not paste raw log bodies, Worker source, env var values, token values, or authorization headers.
- **Stop on auth failures.** If the MCP server returns an auth error, stop and tell the user. Do not guess at missing permissions.
- **No scope creep.** Operate only on the account/zone/resource the user specified. Do not enumerate or modify resources in other accounts or zones.
