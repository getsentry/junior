# API Surface

Use this reference for any Datadog operation.

## Runtime contract

- `loadSkill` returns `available_tools` for this skill, including the exact Datadog MCP `tool_name` values exposed in the current turn.
- Call those exact `tool_name` values directly.
- Use `searchTools` only when you need to rediscover or filter the active Datadog tools later in the same turn.
- Do not hardcode raw Datadog MCP tool names in advance. Tool discovery is part of the workflow.
- Return concrete findings plus Datadog deep links for navigation.

## Provider surface

The packaged plugin points at Datadog's hosted remote MCP server and enables the `core`, `apm`, and `error-tracking` toolsets. Tool exposure is intentionally limited to the read-oriented surface below.

### Tools exposed in this skill

| Tool                                  | Intent                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `search_datadog_logs`                 | Search raw log events by filter (service, host, env, status, query, time window).   |
| `analyze_datadog_logs`                | SQL-style aggregation over logs for counts, group-bys, top-N, and numeric analysis. |
| `search_datadog_events`               | Datadog Events API: deployments, infra changes, alerts, status events.              |
| `search_datadog_metrics`              | List available metrics by name pattern, tag, or service.                            |
| `get_datadog_metric`                  | Query a specific metric time series over a time window.                             |
| `get_datadog_metric_context`          | Fetch metadata and available tag dimensions for a metric.                           |
| `search_datadog_spans`                | Search APM spans by service, operation, tags, time, error state.                    |
| `get_datadog_trace`                   | Fetch a full trace by trace ID.                                                     |
| `search_datadog_services`             | List services from the Software Catalog with ownership and tag metadata.            |
| `search_datadog_service_dependencies` | Upstream/downstream service map for a service, or services owned by a team.         |
| `search_datadog_hosts`                | List monitored hosts with tags and health state.                                    |
| `search_datadog_monitors`             | List monitors, their statuses, and alert conditions.                                |
| `search_datadog_incidents`            | List incidents with severity, state, and metadata.                                  |
| `get_datadog_incident`                | Retrieve a specific incident by ID (timeline detail may be absent).                 |
| `search_datadog_dashboards`           | List available dashboards.                                                          |
| `search_datadog_notebooks`            | List Datadog notebooks by author, tag, or content.                                  |
| `get_datadog_notebook`                | Fetch a notebook by ID.                                                             |
| `search_datadog_rum_events`           | Search Datadog RUM (Real User Monitoring) events for browser / frontend issues.     |

### Tools intentionally not exposed

- Notebook mutations (`create_datadog_notebook`, `edit_datadog_notebook`).
- Monitor, SLO, or incident mutations.
- Feature-flag, DBM, and security toolsets (the packaged URL does not request them).

If a user asks for a mutation, stop and explain that this skill is read-only.

## Operation patterns

| Intent                                           | Minimum tool pattern                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Why is service X failing right now?"            | `search_datadog_monitors` + `analyze_datadog_logs` (top error counts by status or message) + optionally `get_datadog_trace` for one failing trace. |
| "Show me errors for service X in the last hour." | `analyze_datadog_logs` for counts/top-N first; only fall back to `search_datadog_logs` if the user asked for specific log lines.                   |
| "What is the status of monitor X?"               | `search_datadog_monitors` with the monitor name/tag, then cite state + last transition time.                                                       |
| "Tell me about incident INC-123."                | `get_datadog_incident` directly. Only fall back to `search_datadog_incidents` if no ID is known.                                                   |
| "What depends on the checkout service?"          | `search_datadog_service_dependencies` scoped to that service.                                                                                      |
| "How did this trace spend its time?"             | `get_datadog_trace` by ID; cite the slowest spans.                                                                                                 |
| "What tag values are valid for this metric?"     | `get_datadog_metric_context` before `get_datadog_metric`.                                                                                          |
| "Which hosts are unhealthy?"                     | `search_datadog_hosts` filtered by health/tags.                                                                                                    |
| "Find slow page loads."                          | `search_datadog_rum_events` with a page/speed filter.                                                                                              |

## Config helpers

Use these commands only when the user explicitly asks to inspect or store Datadog defaults for the current conversation/channel.

Resolve env default:

```bash
jr-rpc config get datadog.env
```

Set env default:

```bash
jr-rpc config set datadog.env prod
```

Resolve service default:

```bash
jr-rpc config get datadog.service
```

Set service default:

```bash
jr-rpc config set datadog.service checkout
```

## Content expectations

- Translate Slack-thread wording into stable observability language (env, service, status, span, monitor, incident, host).
- Preserve material URLs present in the conversation (Sentry, GitHub, dashboards, prior Datadog links) when they add evidence.
- Include Datadog deep links (`https://app.datadoghq.com/...`) with the answer so users can click through.
- Label assumptions clearly when the thread leaves important details uncertain (chosen env, chosen time window, chosen service).
