---
name: sentry
description: Query Sentry telemetry (issues, events, replays, traces) and generate deep links scoped to users or timeframes. This skill should be used when users ask to investigate bugs, search errors, find replays, or look up Sentry data.
requires-capabilities: sentry.api
uses-config: sentry.org sentry.project
allowed-tools: bash
---

# Sentry Operations

Use this skill for Sentry investigation workflows in the harness.

## Workflow

1. Confirm operation and target:

- Determine operation: `issue list`, `deep-link`, or general query.
- Resolve org from channel config: `jr-rpc config get sentry.org`
- Resolve project from channel config: `jr-rpc config get sentry.project` (optional — many queries span multiple projects).
- If org is missing and needed, ask the user.

2. Execute via CLI:

- Use `sentry <command>` for structured queries.
- The CLI reads `SENTRY_AUTH_TOKEN` from env after the runtime enables the declared Sentry capability for this turn.
- Read [references/cli-commands.md](references/cli-commands.md) for command shapes and flags.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) before relying on sandbox credentials.
- If a Sentry API call returns `401`, or clearly says the token is invalid, expired, revoked, or unauthorized, run `jr-rpc delete-token sentry` to clear the stale token, then retry after re-enabling the declared capability.
- If a Sentry API call returns `403`, `missing scope`, `missing scopes`, `insufficient scope`, `permission denied`, or otherwise indicates missing org/project access, stop and tell the user the current Sentry connection could not access the requested Sentry data.
- Only mention a specific missing scope when the CLI or API error explicitly names that scope. Do not guess scope names from a generic `403`.
- Do not call `jr-rpc delete-token sentry`, do not retry, and do not start OAuth again for scope/permission failures. Reauth with the same app scopes will not fix that class of error.

3. Generate deep links:

- For user-scoped or entity-specific views, generate URLs instead of CLI calls.
- Read [references/deep-link-patterns.md](references/deep-link-patterns.md) for URL templates.

4. Report result:

- Return issue details, replay links, deep links, or CLI output inline.
- Include Sentry web URLs for easy navigation.

## Guardrails

- Read-only operations only (MVP scope).
- Avoid speculative or experimental Sentry CLI subcommands that are not listed in the bundled references.
- Do not print credential values.
- If org is missing and needed, ask the user.
- Prefer deep links over raw data dumps when linking to Sentry web UI.
