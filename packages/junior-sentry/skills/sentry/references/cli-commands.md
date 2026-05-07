# Sentry CLI Command Reference

Open this file when selecting a Sentry CLI command, checking target syntax, or diagnosing an unknown-command failure.

All commands use `sentry` and read `SENTRY_AUTH_TOKEN` from environment.
The npm `sentry` package is intentionally installed at runtime from the plugin manifest, so verify live help before blocking on a missing command.

## Command selection rules

1. Prefer current canonical singular command groups: `issue`, `org`, `log`, `trace`, and `api`.
2. Do not use stale plural subcommands such as `sentry organizations list`.
3. If a command errors as unknown, run `sentry --help` and the nearest subcommand help before declaring the surface unavailable.
4. Prefer `--json` and, when useful, `--fields` for structured parsing.
5. Use `sentry api <endpoint>` for authenticated read-only API calls when a high-level command does not cover the requested data.

## Issue commands

### List issues

```bash
sentry issue list [ORG/PROJECT|ORG/|PROJECT] [--query QUERY] [--period PERIOD] [--sort SORT] [--limit N] [--json]
```

- `ORG/PROJECT`: Explicit organization and project.
- `ORG/`: All projects in an organization. The trailing slash is significant.
- `PROJECT`: Search for a project by name across accessible organizations.
- `--query`: Sentry search query (e.g., `user.email:alice@example.com`, `is:unresolved`).
- `--period`: Time range such as `24h`, `7d`, or an absolute range.
- `--sort`: `date`, `new`, `freq`, or `user`.
- `--limit`: Maximum result count.
- `--json`: Output as JSON for structured parsing.

Use `sentry issue view ISSUE`, `sentry issue events ISSUE`, `sentry issue explain ISSUE`, or `sentry issue plan ISSUE` when the user asks for a specific issue, its events, root cause, or a fix plan.

## Organization commands

### List organizations

```bash
sentry org list [--limit N] [--json]
```

Lists organizations accessible with current token.

### View organization

```bash
sentry org view ORG [--json]
```

Views one organization.

## Log commands

### List logs

```bash
sentry log list [ORG/PROJECT|PROJECT|TRACE_ID|ORG/TRACE_ID] [--query QUERY] [--period PERIOD] [--limit N] [--json]
```

- `ORG/PROJECT`: Explicit project target.
- `PROJECT`: Search for a project by name.
- `TRACE_ID` or `ORG/TRACE_ID`: Filter logs by trace.
- `--query`: Filter query such as `level:error` or `project:[frontend,backend]`.
- `--period`: Time range.
- `--limit`: Maximum result count.

Use `sentry log view [ORG/PROJECT] LOG_ID...` after `log list` returns IDs.

## Trace commands

### List traces

```bash
sentry trace list [ORG/PROJECT|PROJECT] [--query QUERY] [--period PERIOD] [--sort SORT] [--limit N] [--json]
```

Use `sentry trace view [ORG/PROJECT/]TRACE_ID` for trace details.
Use `sentry trace logs [ORG/]TRACE_ID` when the user asks for logs associated with a trace.

## API fallback

```bash
sentry api ENDPOINT [--method METHOD] [--field KEY=VALUE] [--data JSON] [--json]
```

- `ENDPOINT` is relative to `/api/0/`, for example `organizations/` or `issues/123456789/`.
- Use read-only `GET` requests by default.
- Do not use API write methods unless the user explicitly asks for a mutating Sentry action.
- Use `--dry-run` when verifying a complex endpoint or request body.

## Common flags

- `--json`: Structured JSON output (preferred for parsing).
- `--fields`: Comma-separated JSON fields to include.
- `--fresh`: Bypass local CLI caches and re-detect projects.
- `--log-level`: `error`, `warn`, `log`, `info`, `debug`, or `trace`.

## Common use cases

| User request                                          | Command pattern                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| "List my orgs"                                        | `sentry org list --json`                                            |
| "Show issues in frontend"                             | `sentry issue list ORG/frontend --json`                             |
| "Show unresolved errors across the org"               | `sentry issue list ORG/ --query "is:unresolved level:error" --json` |
| "Inspect this issue"                                  | `sentry issue view ISSUE --json`                                    |
| "Show events for this issue"                          | `sentry issue events ISSUE --json`                                  |
| "Find error logs"                                     | `sentry log list ORG/PROJECT --query "level:error" --json`          |
| "Inspect a trace"                                     | `sentry trace view ORG/PROJECT/TRACE_ID --json`                     |
| "Show logs for a trace"                               | `sentry trace logs ORG/TRACE_ID --json`                             |
| "Call an endpoint not covered by high-level commands" | `sentry api organizations/ --json`                                  |

## Troubleshooting

| Symptom                                                             | Likely cause                               | Remedy                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `organizations list` is unavailable                                 | Stale plural command shape                 | Use `sentry org list`; verify with `sentry org list --help`.                                  |
| `issues list --org ORG` is unavailable                              | Stale flag-based command shape             | Use `sentry issue list ORG/` for org-wide or `sentry issue list ORG/PROJECT` for one project. |
| Bare org slug returns project-search behavior                       | Missing org-wide trailing slash            | Use `ORG/` for all projects in an org.                                                        |
| Command group is not remembered                                     | CLI surface may have changed               | Run `sentry --help`, then `sentry <group> --help`.                                            |
| High-level command does not expose the requested read-only resource | CLI command coverage gap                   | Use `sentry api <endpoint>` with a read-only endpoint.                                        |
| Result parsing is brittle                                           | Human table output                         | Add `--json`, and optionally `--fields`.                                                      |
| Results look stale or target detection is wrong                     | Local CLI cache or auto-detection          | Add `--fresh` or pass an explicit `ORG/PROJECT` target.                                       |
| API returns `401` or invalid/expired/revoked token text             | Stale or missing credential                | Rerun the real command once so the runtime can trigger reconnect.                             |
| API returns explicit missing scope text                             | OAuth grant lacks a named scope            | Rerun the real command once so the runtime can trigger reconnect.                             |
| API returns generic `403` or permission denied                      | Connected account lacks org/project access | Stop and tell the user the current connection cannot access the requested data.               |

Use these command shapes during normal skill execution, but treat live CLI help as the final source when this reference and the installed CLI disagree.
