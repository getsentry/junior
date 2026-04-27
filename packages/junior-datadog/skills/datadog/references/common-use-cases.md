# Common Use Cases

Use these patterns to shape concrete Datadog requests.

## 1. Triage "service X is failing right now"

- Default the time window to the last 15 minutes unless the user gave a different one.
- Constrain by `service:` and `env:` (explicit user input wins; fall back to `datadog.service` / `datadog.env`).
- `search_datadog_monitors` for `service:<x>` first — a firing monitor usually names the failure mode.
- Then `analyze_datadog_logs` to aggregate by status/level/message to find the top error shape.
- If the user asks "why", fetch one representative failing trace with `get_datadog_trace` or `search_datadog_spans` filtered to `service:<x> status:error`.
- Report monitor state, top error, and one failing trace link — not a dump.

## 2. "Is this monitor alerting?"

- Use `search_datadog_monitors` with the monitor name, tag, or ID.
- Report state (`OK`, `Warn`, `Alert`, `No Data`), last transition, and the monitor link.
- If the monitor is in `No Data`, note that explicitly — it is not the same as healthy.

## 3. "Tell me about incident INC-123" or "What is the status of the Redis incident?"

- If the user named the incident ID, go straight to `get_datadog_incident`.
- If only a topic was named, use `search_datadog_incidents` filtered by active/severity and scan for a match in the thread's time window.
- Report severity, state, owner, and link to the incident.
- Note that incident timeline detail may be absent from the MCP response; do not fabricate timeline entries.

## 4. Log search with a specific query

- Default to `search_datadog_logs` only when the user explicitly wants raw log lines.
- Constrain with `service:`, `env:`, `status:`, `host:`, or `@<faceted_field>:` as appropriate (see `query-syntax.md`).
- Cap page size and time window to avoid huge responses.
- Report a short summary plus a Datadog logs deep link. Quote only the minimum log content.

## 5. "What are the top errors for service X right now?"

- Prefer `analyze_datadog_logs` with a SQL-style `GROUP BY status` or `GROUP BY @http.status_code` / `GROUP BY @error.kind`.
- Report the top 3-5 buckets with counts, not an exhaustive table.
- Include the aggregated query link so the user can open the same view in Datadog.

## 6. Trace inspection by ID

- Use `get_datadog_trace` with the trace ID.
- Cite the top 3 slowest or error-tagged spans (service, operation, duration, error state).
- If the server marks the trace as truncated, say so — some spans are not present.

## 7. Span search for a known error pattern

- Use `search_datadog_spans` with explicit filters like `service:<x> status:error resource_name:"..."` and a bounded time window.
- Report span counts plus the most illustrative span's trace link.

## 8. Service topology lookup

- Use `search_datadog_service_dependencies` to answer "what calls X?" or "what does X depend on?" or "what does team Y own?".
- Return the dependency list with service names and link back to the Service Catalog page.

## 9. Metric lookup

- Use `search_datadog_metrics` when the user is unsure of the metric name.
- Once the metric name is known, use `get_datadog_metric` with the time window and tag filters.
- Use `get_datadog_metric_context` before querying if the user wants to know which tags (`env`, `service`, `host`, ...) are usable.
- Report headline numbers (current, peak, delta) plus a metric explorer link.

## 10. Host health

- Use `search_datadog_hosts` filtered by tag, role, or `down:true`.
- Return counts, the list of unhealthy hosts (names + tags), and a host map link.

## 11. RUM / frontend slowness

- Use `search_datadog_rum_events` only when the user asked about end-user / browser experience.
- Constrain to `@type:error`, slow page loads, or specific views; bound the time window.
- Do not use RUM for backend errors — those live in logs/APM.

## 12. Dashboards and notebooks

- `search_datadog_dashboards` to list dashboards by topic, team, or tag — useful for "do we already have a dashboard for X?".
- `search_datadog_notebooks` + `get_datadog_notebook` for reading existing investigation notebooks.
- This skill does not create or edit dashboards or notebooks. If the user asks, stop and say so.

## 13. Storing channel defaults

- Treat both defaults as optional fallbacks. Explicit user input wins whenever a request names a different env or service.
