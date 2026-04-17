---
name: datadog
description: Query live Datadog telemetry (logs, metrics, traces, spans, monitors, incidents, dashboards, services, hosts) through Datadog's hosted MCP server. Use when users ask to investigate production behavior in Datadog — searching logs, checking monitor status, inspecting traces or spans, looking up incidents, finding services, or correlating metrics. Do not use it for Sentry issues, repository/source-code work, or ticketing.
uses-config: datadog.env datadog.service
---

# Datadog Operations

Use this skill for Datadog observability investigations in the harness.

## Reference loading

Load references conditionally based on the request:

| Need                                               | Read                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Any Datadog operation                              | [references/api-surface.md](references/api-surface.md)                                                                     |
| Log search, metric query, trace lookup, incidents  | [references/common-use-cases.md](references/common-use-cases.md), [references/query-syntax.md](references/query-syntax.md) |
| Auth failures, permission errors, or tool failures | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md)                                     |

## Workflow

1. Resolve the operation and target:

- Determine whether the request is a log search, metric query, trace/span inspection, monitor lookup, incident lookup, dashboard/notebook lookup, service/host listing, or service-dependency map.
- Prefer explicit env, service, host, monitor/incident IDs, trace IDs, or Datadog URLs when the user provides them.
- When the user did not specify a scope, treat `datadog.env` and `datadog.service` conversation config as optional defaults. Explicit user input always wins over config.
- Only set or change `datadog.env` and `datadog.service` when the user explicitly asks to store a default for this conversation or channel.
- If the request refers to an earlier telemetry item indirectly (an incident, trace, or monitor already mentioned in the thread), inspect the current thread for the existing ID or URL before asking the user to restate it.
- Ask one concise follow-up only when a search is genuinely under-specified, for example when the user asks about "errors" with no env, service, or time window hint and the thread has no prior context.

2. Use the active Datadog MCP tools:

- `loadSkill` returns `available_tools` for this skill, including the exact `tool_name` values and input schemas exposed in this turn.
- Call those exact tool names directly. Use `searchTools` only if you need to rediscover or filter the active Datadog tools later in the same turn.
- Start narrow: pick the single most direct tool for the request before reaching for broader search.
  - Known incident ID → `get_datadog_incident`
  - Known trace ID → `get_datadog_trace`
  - Known notebook ID → `get_datadog_notebook`
  - Known metric name → `get_datadog_metric` (and `get_datadog_metric_context` when the user wants available tags or dimensions)
- For exploratory questions, prefer one `search_datadog_*` call with a tight query, then one follow-up fetch if needed.
- For "what is the current error rate / log volume / top offenders" style questions, prefer `analyze_datadog_logs` (SQL-style aggregation) over pulling raw log pages back through `search_datadog_logs`.
- For service-topology questions ("what calls checkout?", "what does the payment API depend on?"), prefer `search_datadog_service_dependencies` over manually stitching spans together.
- Use `search_datadog_monitors` for "is this alerting?" or "what is monitor X doing?"; use `search_datadog_incidents` / `get_datadog_incident` for incident context.
- Use `search_datadog_rum_events` only when the user asks about real-user / browser telemetry, not for backend issues.

3. Bound every query:

- Always constrain time windows. Default to the last 15 minutes for "right now" questions and the last 24 hours for retrospective questions; otherwise use the window the user named.
- Always include `env:` when `datadog.env` is set or the user named an env.
- Always include `service:` when the user named a service or `datadog.service` is set and the tool is service-scoped.
- Cap result size. Prefer the default or small page sizes; do not page through thousands of logs when an aggregate tool answers the question.

4. Report the result:

- Return the concrete answer first (counts, status, incident severity, trace timing, top offenders), then a short evidence block.
- Include Datadog deep links (e.g. `https://app.datadoghq.com/logs?query=...`, `https://app.datadoghq.com/apm/trace/<id>`, `https://app.datadoghq.com/incidents/<id>`) so Slack users can click through.
- Preserve interesting spans, log lines, or metric values inline only when they are the evidence for the answer. Do not dump raw tool output.
- Keep routine tool chatter silent. Do not narrate each MCP search or fetch step.

## Guardrails

- Read-only only in this skill. Do not create, edit, mute, or resolve monitors, incidents, notebooks, dashboards, SLOs, or feature flags — the plugin intentionally does not expose those tools.
- Log, RUM, APM, and incident payloads can contain PII or sensitive customer data. Quote only the minimum needed to answer the question. Do not paste full raw log bodies or span payloads when a summary plus a deep link is enough.
- If Datadog authorization is required, let the MCP OAuth flow pause and resume the thread automatically instead of asking the user to handle credentials manually.
- If a Datadog tool returns a generic `403`, `permission denied`, or similar, stop and tell the user the current Datadog connection could not access the requested resource. Do not guess at missing RBAC scopes.
- If Datadog responds with `429 Too Many Requests`, wait briefly and retry the same query once. If it still fails, report the throttle and stop.
- For large traces that the server marks as truncated, report that fact; do not pretend the shown spans are complete.
- Do not use this skill for Sentry issues, Linear/GitHub ticketing, or source-code investigation. Hand those off to the matching skill.
