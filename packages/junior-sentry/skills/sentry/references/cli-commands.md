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

## API fallback

```bash
sentry api ENDPOINT [--method METHOD] [--field KEY=VALUE] [--data JSON] [--json]
```

- `ENDPOINT` is relative to `/api/0/`, for example `organizations/` or `issues/123456789/`.
- Use read-only `GET` requests by default.
- The supported write surface is explicitly requested alert or monitor operations. Do not mutate unrelated Sentry resources.
- Use `--dry-run` before every write to verify the endpoint, method, and JSON body.

## Alert and monitor API

Sentry's current alerting model separates detection from notification:

1. A **monitor** detects a condition for one project.
2. An **alert** (workflow) connects one or more monitors to notification actions.

Use the current public endpoints:

```text
GET  organizations/ORG/detectors/
POST organizations/ORG/projects/PROJECT/detectors/
GET  organizations/ORG/workflows/
POST organizations/ORG/workflows/
```

These are labeled **Monitors** and **Alerts** in Sentry's public API docs even though their paths use `detectors` and `workflows`. Do not use `POST .../alert-rules/`; legacy metric alert-rule creation is deprecated.

Before creating anything:

- Resolve the exact org and project.
- List existing monitors and alerts and stop on a likely duplicate unless the user explicitly asks for another.
- Resolve IDs for owners, integrations, notification targets, and existing workflows instead of guessing them.
- Validate each write with `--dry-run`, then execute it once.
- A monitor without a connected alert does not notify. Create or connect the alert workflow when notification is part of the request.

### Metric monitor body

The current monitor payload uses this shape:

```json
{
  "name": "Non-Zod error spike",
  "type": "metric_issue",
  "projectId": "PROJECT_ID",
  "owner": "team:TEAM_ID",
  "workflowIds": [],
  "conditionGroup": {
    "logicType": "any",
    "conditions": [
      {"type": "gt", "comparison": 50, "conditionResult": 75},
      {"type": "lte", "comparison": 50, "conditionResult": 0}
    ]
  },
  "config": {"detectionType": "static"},
  "dataSources": [
    {
      "aggregate": "count()",
      "dataset": "events",
      "eventTypes": ["error"],
      "query": "!error.type:ZodError",
      "queryType": 0,
      "timeWindow": 3600,
      "environment": "production"
    }
  ]
}
```

For dynamic detection, replace the conditions and config with:

```json
{
  "conditionGroup": {
    "logicType": "any",
    "conditions": [
      {
        "type": "anomaly_detection",
        "comparison": {
          "sensitivity": "low",
          "seasonality": "auto",
          "thresholdType": 0
        },
        "conditionResult": 75
      }
    ]
  },
  "config": {"detectionType": "dynamic"}
}
```

Preserve the rest of the monitor body. `timeWindow` is seconds. Verify current dataset, event type, query type, threshold direction, and action payloads against live API docs or an existing comparable resource before writing; these contracts can vary by deployment and alert type.

### Alert workflow body

Create notification behavior through the organization alert endpoint after resolving the monitor ID and notification action configuration. The payload contains `name`, `detectorIds`, trigger conditions, action filters/actions, environment, frequency config, owner, and enabled state. Because integration/action shapes vary, inspect an existing comparable alert or the current API schema and copy only verified IDs and fields; do not invent Slack integration or channel identifiers.

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
| "Create a metric monitor"                            | Resolve target and duplicates, dry-run monitor POST, then execute   |
| "Notify Slack when a monitor fires"                  | Create/connect an alert workflow after resolving action IDs         |

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
| Monitor exists but no notification is sent                          | No connected alert workflow/action        | Create or connect an alert workflow with verified notification target IDs.                    |
| `POST .../alert-rules/` is deprecated                               | Legacy metric-alert endpoint              | Use the current monitor endpoint plus an alert workflow for notification.                      |

Use these command shapes during normal skill execution, but treat live CLI help as the final source when this reference and the installed CLI disagree.
