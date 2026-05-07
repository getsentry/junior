---
name: sentry
description: Query live Sentry telemetry with the Sentry CLI and generate Sentry deep links. Use when users ask to investigate Sentry issues, events, logs, traces, organizations, projects, replays, or authenticated Sentry API data. Do not use it for repository/source-code/PR tasks, even when the topic concerns Sentry products.
allowed-tools: bash
---

# Sentry Operations

Use this skill for live Sentry investigation workflows in the harness.

Before declaring a Sentry data surface unavailable, verify the current CLI help:

- Run `sentry --help` for top-level command groups.
- Run `sentry <command> --help` or `sentry help <command>` before using a command shape from memory.
- If a remembered plural command fails, check for the current singular command group before blocking. Prefer canonical forms such as `sentry issue list`, `sentry org list`, `sentry log list`, and `sentry trace list`.

## Workflow

1. Confirm operation and target:

- Determine operation: issue, event, log, trace, org, project, replay/deep-link, or API query.
- Resolve org from channel config: `jr-rpc config get sentry.org`
- Resolve project from channel config: `jr-rpc config get sentry.project` (optional — many queries span multiple projects).
- If org is missing and needed, ask the user.

2. Execute via CLI:

- Use `sentry <command>` for structured queries.
- The runtime injects `SENTRY_AUTH_TOKEN` automatically for authenticated `sentry` CLI commands in this skill.
- Read [references/cli-commands.md](references/cli-commands.md) when choosing command shapes, target formats, flags, API fallback, or troubleshooting behavior.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) before relying on sandbox credentials.
- Prefer `--json` when parsing or summarizing results.
- If no high-level CLI command covers the requested read-only data, use `sentry api <endpoint>` before claiming the workflow is blocked.
- If a Sentry API call returns `401`, or clearly says the token is invalid, expired, revoked, or unauthorized, rerun the real Sentry command once and let the runtime trigger a reconnect flow when needed.
- If a Sentry API call explicitly says `missing scope`, `missing scopes`, or `insufficient scope`, rerun the real Sentry command once and let the runtime trigger a reconnect flow when needed.
- If a Sentry API call returns a generic `403`, `permission denied`, or otherwise indicates missing org/project access without naming missing scopes, stop and tell the user the current Sentry connection could not access the requested Sentry data.
- Only mention a specific missing scope when the CLI or API error explicitly names that scope. Do not guess scope names from a generic `403`.

3. Generate deep links:

- For user-scoped or entity-specific views, generate URLs instead of CLI calls.
- Read [references/deep-link-patterns.md](references/deep-link-patterns.md) for URL templates.

4. Report result:

- Return issue details, replay links, deep links, or CLI output inline.
- Include Sentry web URLs for easy navigation.

## Guardrails

- Read-only operations only (MVP scope).
- Avoid speculative Sentry CLI subcommands. Use bundled references plus live `sentry --help` output to verify current commands.
- Do not print credential values.
- If org is missing and needed, ask the user.
- Prefer deep links over raw data dumps when linking to Sentry web UI.
- Do not use this skill for repository/source-code/commit/branch/pull-request work, even if the user mentions a Sentry feature or product area.
