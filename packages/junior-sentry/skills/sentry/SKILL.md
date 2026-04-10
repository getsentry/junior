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
- If the user gives a target in `owner/repo` form (for example `sentry/junior` or `getsentry/sentry`), treat that as ambiguous by default. That shape is usually a GitHub repository, not a Sentry org/project identifier.
- For `owner/repo` targets, do not assume it is a Sentry project. Ask whether they mean a GitHub repo or a Sentry org/project, unless the surrounding request clearly says Sentry and provides separate org/project context.
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
- When returning exactly one concrete Sentry issue and you have the structured fields available (`shortId`, `title`, `permalink`, `status`, plus any optional metadata), prefer rendering a `sentry.issue` card before the short text summary.
- The card itself is enough for straightforward single-issue answers. If you do not have extra interpretation or a next-step question, end the turn after rendering the card.
- When you render a `sentry.issue` card, do not restate the issue title, status, project, or link as bullets in the assistant text. Keep any accompanying text to a brief orientation or next-step question.
- Do not render cards for multi-issue lists, broad search results, or ambiguous issue matches. Use concise text for those.

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
