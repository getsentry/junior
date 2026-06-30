# Query Syntax

Use this reference when forming Datadog log queries, span queries, RUM queries, and Pup aggregate commands.

## Log search query syntax

Datadog log search queries are tag-and-facet based. Core building blocks:

| Form               | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `service:<name>`   | Reserved attribute: service emitting the log.                       |
| `env:<name>`       | Reserved attribute: deployment environment tag.                     |
| `host:<name>`      | Reserved attribute: emitting host.                                  |
| `status:<level>`   | Log level: `error`, `warn`, `info`, `debug`, etc.                   |
| `source:<name>`    | Log source integration, for example `nginx` or `python`.            |
| `@<field>:<value>` | Faceted attribute: custom JSON field, e.g. `@http.status_code:500`. |
| `"some phrase"`    | Free-text phrase search.                                            |
| `AND`, `OR`, `-`   | Boolean ops; `-` negates. Default operator between terms is `AND`.  |
| `(a OR b) AND c`   | Parenthesized boolean expression.                                   |

Common examples:

- `service:checkout env:prod status:error`
- `service:api env:prod @http.status_code:(500 OR 502 OR 503)`
- `service:worker -status:info "timeout"`
- `@error.kind:DatabaseError env:prod`

Tips:

- Prefer `@<field>:` form over free-text search when the field exists. Facet matches are cheaper and more precise.
- `status` and `@http.status_code` are different. `status` is the log level; `@http.status_code` is the HTTP response code.
- Reserved attributes (`service`, `env`, `host`, `status`, `source`) do not take the `@` prefix. Custom fields do.

## Pup log commands

- Raw logs: `pup --read-only --agent logs search --query="service:checkout env:prod status:error" --from="15m" --to="now" --limit=20`
- Alternate v2 listing: `pup --read-only --agent logs list --query="service:checkout env:prod" --from="1h" --limit=20`
- Aggregation: `pup --read-only --agent logs aggregate --query="service:checkout env:prod status:error" --compute=count --group-by=@error.kind --limit=10`

`logs aggregate` options to prefer for analytics:

- `--compute=count` for volume.
- `--compute="avg(@duration)"`, `sum(...)`, `min(...)`, `max(...)`, or `percentile(@duration, 95)` for numeric fields.
- `--group-by=status`, `service`, `host`, `@http.status_code`, `@error.kind`, or another facet.
- `--limit=10` unless the user needs more.

## Span / APM search

APM span search shares the same query language, plus a few APM-specific attributes:

| Attribute          | Meaning                                   |
| ------------------ | ----------------------------------------- |
| `service:<name>`   | Service emitting the span.                |
| `env:<name>`       | Deployment environment tag.               |
| `operation_name:X` | Span operation name, e.g. `http.request`. |
| `resource_name:X`  | Endpoint or handler.                      |
| `status:error`     | Span is marked as an error.               |
| `@duration:>...`   | Duration filter in nanoseconds.           |

Commands:

- `pup --read-only --agent traces search --query="service:checkout env:prod status:error" --from="15m" --limit=20`
- `pup --read-only --agent traces aggregate --query="service:checkout env:prod" --compute="percentile(@duration, 95)" --group-by=resource_name`
- For a trace ID, use `traces search --query="trace_id:<id>"` with a window that brackets the trace. Pup returns matching spans; do not assume it returned a complete tree unless the output proves it.

## RUM queries

Use RUM only for browser/user-experience questions:

- `pup --read-only --agent rum events --query='@type:error @application.name:"Web"' --from="1h" --limit=20`
- `pup --read-only --agent rum aggregate --query='@type:view' --compute="percentile(@view.loading_time, 95)" --group-by=@view.name`
- `pup --read-only --agent rum sessions search --query='@session.type:user' --from="1h" --limit=20`

## Metric queries

Datadog metric query strings follow the usual metric explorer shape:

- `avg:system.cpu.user{env:prod,service:checkout}`
- `sum:trace.http.request.errors{env:prod,service:checkout}.as_count()`
- `p95:trace.http.request.duration{env:prod,service:checkout}`

Use `metrics search` or `metrics list` to find names, `metrics metadata get` for metadata, and `metrics tags list` for tag dimensions before querying when needed.

## Time windows

- For "right now" questions, default to the last 15 minutes.
- For "what happened earlier today" questions, default to the last 24 hours.
- For incident-linked questions, prefer a window that brackets the incident `created` time.
- Always include a time window. Unbounded queries are slow and easy to misinterpret.

## What to cite back

- The exact query string used, for example `service:checkout env:prod status:error`.
- The time window you used.
- A Datadog deep link when Pup returns one or when a stable ID-specific app link is available.
