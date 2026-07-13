---
name: sentry
description: Query live Sentry telemetry, create explicitly requested Sentry alerts and monitors, and generate Sentry deep links. Use when users ask to investigate Sentry issues, events, logs, traces, organizations, projects, replays, product feature usage, Sentry's own product telemetry, authenticated Sentry API data, or to create alerting. Do not use it for repository/source-code/PR tasks, even when the topic concerns Sentry products.
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

- Determine operation: issue, event, log, trace, org, project, replay/deep-link, Sentry product feature usage, alert/monitor creation, or API query.
- Resolve org from channel config: `jr-rpc config get sentry.org`
- Resolve project from channel config: `jr-rpc config get sentry.project` (optional — many queries span multiple projects).
- If org is missing and needed, ask the user.
- If an active repository context exists (cloned repo or configured `github.repo`), check the repo root for `TELEMETRY.md` before forming queries. When present, use its query recipes, org/project mappings, and investigation pivots as repo-specific guidance. Explicit user targets, IDs, URLs, and conversation config still win. If absent, continue normally.

2. Execute via CLI:

- Use `sentry <command>` for structured queries.
- The runtime authenticates Sentry HTTP traffic for this skill. Do not set or print token env vars.
- Read [references/cli-commands.md](references/cli-commands.md) when choosing command shapes, target formats, flags, API fallback, or troubleshooting behavior.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) before relying on sandbox credentials.
- Prefer `--json` when parsing or summarizing results.
- If no high-level CLI command covers the request, use `sentry api <endpoint>` before claiming the workflow is blocked.
- Create alerts only when the user explicitly asks. Prefer `sentry alert metrics` for metric-alert list/view/create/edit/delete; before writing, resolve the exact target, check duplicates, run the complete command with `--dry-run`, then execute once and report the created rule URL.
- Use `sentry api` only when live CLI help confirms the first-class command cannot express the requested alert behavior, such as dynamic anomaly detection.
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

- Default to read-only operations. Only create, edit, or delete alerting resources when the user explicitly requests that exact action and a documented first-class CLI command supports it. Use API fallback only for explicitly requested alert behavior that live CLI help confirms is unsupported.
- Avoid speculative Sentry CLI subcommands. Use bundled references plus live `sentry --help` output to verify current commands.
- Do not print credential values.
- If org is missing and needed, ask the user.
- Prefer deep links over raw data dumps when linking to Sentry web UI.
- Do not use this skill for repository/source-code/commit/branch/pull-request work, even if the user mentions a Sentry feature or product area.
