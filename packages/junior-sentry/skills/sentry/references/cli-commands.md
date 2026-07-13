# Sentry CLI Command Reference

Open this file when selecting a Sentry CLI command, checking target syntax, or diagnosing an unknown-command failure.

All commands use `sentry`; authenticated Sentry HTTP traffic is supplied by the runtime.
The npm `sentry` package is intentionally installed at runtime from the plugin manifest, so verify live help before blocking on a missing command. Do not configure or print token env vars.

## Command selection rules

1. Prefer current canonical singular command groups: `issue`, `org`, `log`, `trace`, and `api`.
2. Do not use stale plural subcommands such as `sentry organizations list`.
3. If a command errors as unknown, run `sentry --help` and the nearest subcommand help before declaring the surface unavailable.
4. Prefer `--json` and, when useful, `--fields` for structured parsing.
5. Use `sentry api <endpoint>` for authenticated API calls when a high-level command does not cover the request. Default to `GET`; only perform documented alert or monitor mutations when explicitly requested.

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

## Metric alert commands

Use the first-class CLI surface for metric alerts:

```bash
sentry alert metrics list ORG/ [--query NAME] [--fresh] [--json]
sentry alert metrics view ORG/RULE_ID_OR_NAME [--json]
sentry alert metrics create ORG --name NAME --query QUERY --aggregate AGGREGATE \
  --dataset DATASET --time-window MINUTES --trigger TRIGGER_JSON \
  [--project PROJECT]... [--environment ENVIRONMENT] [--owner OWNER] [--dry-run] [--json]
sentry alert metrics edit ORG/RULE_ID_OR_NAME [OPTIONS]
sentry alert metrics delete ORG/RULE_ID_OR_NAME [--dry-run]
```

Before creating a rule:

- Run `sentry alert metrics create --help` and treat live help as authoritative.
- Resolve the exact org, project, owner, integration, and notification target IDs.
- List existing rules and stop on a likely duplicate unless the user explicitly asks for another.
- Run the complete create command with `--dry-run`, then execute it once without `--dry-run`.
- Pass each trigger as JSON with `--trigger`; do not guess action IDs or target identifiers.

Example static error-volume rule:

```bash
sentry alert metrics create ORG \
  --name 'Non-Zod error spike' \
  --query '!error.type:ZodError' \
  --aggregate 'count()' \
  --dataset errors \
  --time-window 60 \
  --project PROJECT \
  --environment production \
  --owner 'team:TEAM_ID' \
  --trigger '{"alertThreshold":50,"actions":[...]}' \
  --dry-run
```

The current CLI create command exposes threshold triggers but no dynamic/anomaly detection flags. If the user explicitly needs anomaly detection, verify live CLI help first; when still unsupported, use `sentry api` with the current public monitor/alert API rather than inventing CLI flags.

## API fallback

```bash
sentry api ENDPOINT [--method METHOD] [--field KEY=VALUE] [--data JSON] [--json]
```

Use `sentry api` only when no first-class CLI command covers the requested operation. Default to read-only `GET` requests. For an explicitly requested alerting write, validate with `--dry-run` and verify the current API schema before executing. Do not mutate unrelated Sentry resources.

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
| "Create a static metric alert"                       | `sentry alert metrics create ... --dry-run`, then execute           |
| "Create a dynamic anomaly alert"                     | Verify CLI help; use API fallback only if still unsupported         |

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
| Alert write returns an explicit missing-scope error                  | OAuth grant predates alert writes         | Rerun once to trigger reconnect; the connection needs `alerts:write`.                          |
| Static metric alert requested                                       | First-class CLI command is available       | Use `sentry alert metrics create`; do not drop directly to `sentry api`.                        |
| Dynamic/anomaly alert flags are unavailable                         | CLI coverage gap                          | Verify live help, then use the current API fallback if needed.                                 |

Use these command shapes during normal skill execution, but treat live CLI help as the final source when this reference and the installed CLI disagree.
