# Common Use Cases

Use these patterns to shape concrete Datadog requests.

## 1. Triage "service X is failing right now"

- Default the time window to the last 15 minutes unless the user gave a different one.
- Constrain by `service:` and `env:`. Explicit user input wins; fall back to `datadog.service` / `datadog.env`.
- Run `pup --read-only --agent monitors search --query="service:<x>"` or `monitors list --tags=service:<x>,env:<env>` first; a firing monitor usually names the failure mode.
- Then run `pup --read-only --agent logs aggregate --query="service:<x> env:<env>" --from="15m" --to="now" --compute=count --group-by=status` or group by an error facet such as `@error.kind`.
- If the user asks "why", search representative failing spans with `pup --read-only --agent traces search --query="service:<x> env:<env> status:error" --from="15m" --limit=20`.
- Report monitor state, top error, and one representative trace/span link when available.

## 2. "Is this monitor alerting?"

- If the user gave a monitor ID, run `pup --read-only --agent monitors get <id>`.
- Otherwise run `pup --read-only --agent monitors search --query="<name or tag>"` or `monitors list --name="<name>" --tags=...`.
- Report state (`OK`, `Warn`, `Alert`, `No Data`), last transition if present, and the monitor link.
- If the monitor is in `No Data`, note that explicitly; it is not the same as healthy.

## 3. "Tell me about incident INC-123" or "What is the status of the Redis incident?"

- If the user named the incident ID, run `pup --read-only --agent incidents get <id>`.
- If only a topic was named, run `pup --read-only --agent incidents list --query="state:active <topic>" --limit=20` and scan for a match in the thread's time window.
- Report severity, state, owner/team if present, and link to the incident.
- Do not fabricate timeline entries if Pup does not return them.

## 4. Log search with a specific query

- Use `pup --read-only --agent logs search` only when the user explicitly wants raw log lines.
- Constrain with `service:`, `env:`, `status:`, `host:`, or `@<faceted_field>:` as appropriate.
- Cap page size and time window to avoid huge responses.
- Report a short summary plus a Datadog logs deep link when available. Quote only the minimum log content.

## 5. "What are the top errors for service X right now?"

- Prefer `pup --read-only --agent logs aggregate --query="service:<x> env:<env> status:error" --compute=count --group-by=@error.kind --limit=10`.
- Use `--group-by=@http.status_code`, `status`, `service`, `host`, or another facet when it better matches the question.
- Report the top 3-5 buckets with counts, not an exhaustive table.

## 6. Trace inspection by ID

- Pup exposes span search. Use `pup --read-only --agent traces search --query="trace_id:<id>" --from=<window> --to=<window> --limit=100`.
- Cite the top 3 slowest or error-tagged spans: service, resource/operation, duration, error state.
- If the returned spans look partial, say so. Do not claim a complete trace tree unless the output proves it.

## 7. Span search for a known error pattern

- Use `pup --read-only --agent traces search --query='service:<x> env:<env> status:error resource_name:"..."' --from=... --to=...`.
- For counts or latency buckets, use `pup --read-only --agent traces aggregate --query="service:<x> env:<env>" --compute=count --group-by=resource_name`.
- Report counts plus the most illustrative span's trace link when available.

## 8. Service topology lookup

- Use `pup --read-only --agent apm dependencies list --env <env> --from=... --to=...` to answer dependency questions.
- Use `pup --read-only --agent apm flow-map --query="service:<x>" --env <env> --from=... --to=...` when the question is centered on one service.
- Return the dependency list with service names and a Service Catalog/APM link when available.

## 9. Metric lookup

- Use `pup --read-only --agent metrics search --query="<pattern>"` or `metrics list --filter="<pattern>"` when the user is unsure of the metric name.
- Once the metric name is known, use `pup --read-only --agent metrics query --query="avg:<metric>{env:<env>,service:<service>}" --from=... --to=...`.
- Use `pup --read-only --agent metrics metadata get <metric>` and `metrics tags list <metric> --from=... --to=...` before querying if the user wants valid tags.
- Report headline numbers: current, peak, delta, or bucketed values as appropriate.

## 10. Host health

- Use `pup --read-only --agent infrastructure hosts list --filter="env:<env> <role-or-service>" --count=50`.
- Use `pup --read-only --agent infrastructure hosts get <hostname>` for a specific host.
- Return counts, unhealthy host names/tags, and a host map link when available.

## 11. RUM / frontend slowness

- Use `pup --read-only --agent rum aggregate` for top views/errors and `rum events` only when the user needs example events.
- Use `pup --read-only --agent rum sessions search` for session questions.
- Constrain to `@type:error`, slow page loads, or specific views; bound the time window.
- Do not use RUM for backend errors; those live in logs/APM.

## 12. Dashboards and notebooks

- `pup --read-only --agent dashboards list` and `dashboards get <id>` are useful for "do we already have a dashboard for X?".
- `pup --read-only --agent notebooks list` and `notebooks get <id>` are for reading investigation notebooks.
- This skill does not create or edit dashboards or notebooks.

## 13. Storing channel defaults

- Treat both defaults as optional fallbacks. Explicit user input wins whenever a request names a different env or service.
