# Query Syntax

Use this reference when forming Datadog log queries, span queries, and log analytics (`analyze_datadog_logs`) SQL.

## Log search query syntax

Datadog log search queries are tag-and-facet based. Core building blocks:

| Form               | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `service:<name>`   | Reserved attribute — service emitting the log.                       |
| `env:<name>`       | Reserved attribute — deployment environment tag.                     |
| `host:<name>`      | Reserved attribute — emitting host.                                  |
| `status:<level>`   | Log level: `error`, `warn`, `info`, `debug`, etc.                    |
| `source:<name>`    | Log source integration (e.g. `nginx`, `python`).                     |
| `@<field>:<value>` | Faceted attribute (custom JSON field), e.g. `@http.status_code:500`. |
| `"some phrase"`    | Free-text phrase search.                                             |
| `AND`, `OR`, `-`   | Boolean ops; `-` negates. Default operator between terms is `AND`.   |
| `(a OR b) AND c`   | Parenthesized boolean expression.                                    |

Common examples:

- `service:checkout env:prod status:error`
- `service:api env:prod @http.status_code:(500 OR 502 OR 503)`
- `service:worker -status:info "timeout"`
- `@error.kind:DatabaseError env:prod`

Tips:

- Prefer `@<field>:` form over free-text search when the field exists. Facet matches are cheaper and more precise.
- `status` and `@http.status_code` are different. `status` is the log level; `@http.status_code` is the HTTP response code.
- Reserved attributes (`service`, `env`, `host`, `status`, `source`) do not take the `@` prefix. Custom fields do.

## Span / APM search

APM span search shares the same query language, plus a few APM-specific attributes:

| Attribute          | Meaning                                    |
| ------------------ | ------------------------------------------ |
| `service:<name>`   | Service emitting the span.                 |
| `env:<name>`       | Deployment environment tag.                |
| `operation_name:X` | Span operation name (e.g. `http.request`). |
| `resource_name:X`  | Endpoint or handler.                       |
| `status:error`     | Span is marked as an error.                |
| `duration:>500ms`  | Range filter on span duration.             |

## `analyze_datadog_logs` SQL

`analyze_datadog_logs` takes SQL-like aggregations over the same log data. Prefer it for counts, top-N, group-bys, and time-bucketed analytics instead of paging raw logs.

Conventions:

- Wrap log query filters in a `WHERE` clause using the same log-search query syntax (quoted as a string).
- Use `COUNT(*)` for volume, `COUNT(DISTINCT <field>)` for unique cardinality.
- `GROUP BY` faceted fields (without `@` in the SQL form — the tool's schema specifies how to reference them; follow the tool's input schema exactly).
- Cap with `ORDER BY ... DESC LIMIT N` — top 5-10 is usually enough.

Example intents (shape — not a literal string; call the tool with the input schema it advertises):

- Top 10 services by error count in the last hour.
- HTTP 5xx count by status code in the last 15 minutes, grouped by `@http.status_code`.
- Log volume by `host` over the last hour to spot a noisy emitter.

## Time windows

- For "right now" questions, default to the last 15 minutes.
- For "what happened earlier today" questions, default to the last 24 hours.
- For incident-linked questions, prefer a window that brackets the incident `created` time.
- Always include a time window — unbounded queries are slow and easy to misinterpret.

## What to cite back

- The exact query string used (`service:checkout env:prod status:error`) — users often want to click through.
- A Datadog deep link that encodes the same filter:
  - `https://app.datadoghq.com/logs?query=<url-encoded-query>&from_ts=<ms>&to_ts=<ms>`
  - `https://app.datadoghq.com/apm/traces?query=<url-encoded-query>`
- The time window you used.
