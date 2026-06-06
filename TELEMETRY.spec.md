# Telemetry File Spec

Status: draft
Spec file: `TELEMETRY.spec.md`
Target file: repository-root `TELEMETRY.md`

## Purpose

`TELEMETRY.md` is an agent-readable production query map.

It must help an investigator move from:

```text
debugging scenario -> starting clue -> query surface -> correlation pivot -> query recipe
```

It is not a telemetry inventory, OTel audit, migration plan, backend tutorial,
or observability design doc.

## Success Criteria

| Check            | Pass Condition                                                  |
| ---------------- | --------------------------------------------------------------- |
| Symptom-first    | A production failure maps to a query path in under a minute.    |
| Backend-specific | Query surfaces name the actual backend and dataset.             |
| Pivot-clear      | Trace/span IDs and product-to-telemetry joins are easy to find. |
| Short            | An agent can scan it before querying telemetry.                 |
| Not a backlog    | Migrations and cleanup work live elsewhere.                     |

## Required Shape

Start with YAML frontmatter:

```yaml
---
spec: ./TELEMETRY.spec.md
---
```

Use these sections, in this order:

1. `Goal`
2. `Where To Query`
3. `Investigation Pivots`
4. `Query Recipes`
5. `Domains`
6. `Configuration`

Optional:

- `Attribute Notes`: only for cross-cutting or ambiguous attributes.
- `References`: only canonical standards/backend docs.

## Section Rubric

| Section                | Job                               | Include                                                   | Cut                                                               |
| ---------------------- | --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `Goal`                 | State when to use the file.       | Production scope, primary backend, likely starting clues. | Company mission, architecture overview, observability philosophy. |
| `Where To Query`       | Pick the right telemetry surface. | Starting clue, backend/dataset, pivot, answer, next step. | Signal inventories, emitter lists, setup tutorials.               |
| `Investigation Pivots` | Join user reports to telemetry.   | 5-10 IDs/tags that cross logs/errors/spans/UI.            | Every ID in the system.                                           |
| `Query Recipes`        | Give first moves.                 | Copyable queries for top incidents.                       | Dashboards, screenshots, long query language lessons.             |
| `Domains`              | Map symptoms to handles.          | Critical workflows, one-line descriptions, key handles.   | Exhaustive event lists.                                           |
| `Configuration`        | Explain telemetry switches.       | Env vars/flags that affect emission or links.             | General app config.                                               |
| `Attribute Notes`      | Disambiguate key fields.          | Sensitive, overloaded, local, or cross-domain fields.     | OTel migration backlog.                                           |
| `References`           | Anchor standards.                 | Official OTel/backend docs.                               | Blog posts, general learning links.                               |

## Format Rules

- Use tables only when cells stay short.
- Use label lists when values are long, especially event/span/attribute
  handles.
- Prefer query blocks over prose.
- Prefer stable handles over exhaustive coverage.
- Prefer `trace_id` and `span_id` for telemetry joins; use product IDs to get
  there.
- Put the spec reference in frontmatter; do not bury it in prose.
- Bias toward production triage, not instrumentation design.
- Use real backend names: `Sentry Logs`, `Datadog APM`, `Honeycomb`, etc.
- Use OpenTelemetry semantic attributes when available.
- Use `app.*` only for app-owned concepts.
- Mark local fields as `app` or `local`; do not audit them.
- Keep example values fake: `<conversation_id>`, `<trace_id>`, `<span_id>`.
- Do not include raw request bodies, user content, auth headers, tokens, or real
  IDs.

## Query Surface Template

| Starting Point        | Query Surface       | Pivot               | Answers              | Next Step         |
| --------------------- | ------------------- | ------------------- | -------------------- | ----------------- |
| `<thread or user ID>` | `<backend dataset>` | `<correlation key>` | workflow state       | run recipe        |
| `<event_id>`          | `<backend event>`   | `trace_id`          | exception context    | open trace/logs   |
| `<event.name>`        | `<backend logs>`    | `<event attribute>` | failure cohort       | inspect domain    |
| `<trace_id>`          | `<backend traces>`  | `span_id`           | timeline and latency | inspect slow span |

## Pivot Template

| Pivot         | Meaning               | Found In                  | First Query       |
| ------------- | --------------------- | ------------------------- | ----------------- |
| `trace_id`    | one distributed trace | errors, logs, spans       | open trace        |
| `span_id`     | one span in a trace   | logs, spans               | inspect span      |
| `event_id`    | captured error event  | user-visible error, issue | open event        |
| `<domain.id>` | product correlation   | product UI, logs, spans   | query logs/traces |

## Query Template

```text
dataset=<dataset> query='<filter with <placeholder>>'
fields=<timestamp>,<event/span>,<pivot>,<error>
sort=<sort>
```

Every query recipe should answer one concrete production question:

- Did ingress accept the request?
- Did the user-visible workflow start?
- Did it fail in model/tool/delivery/auth?
- Which query should I run next?

## Domain Template

```md
### <Domain>

<One-line description of the symptom or workflow.>

Events: `event_a`, `event_b`

Spans: `span.name`, `span.op`

Attributes: `pivot.id`, `app.reason`
```

Domain count guidance:

| Repo Size         | Domain Count                      |
| ----------------- | --------------------------------- |
| small service     | 2-4                               |
| product app       | 4-8                               |
| platform/monorepo | 6-12, grouped by incident surface |

Split a domain only when it changes the first query or telemetry surface.

## Review Checklist

Before accepting a `TELEMETRY.md`:

- Can an agent start from a user-provided error ID, trace ID, thread URL, order
  ID, job ID, or request ID?
- Are the first queries copyable without reading implementation code?
- Does each domain map to a failure symptom?
- Are sensitive fields called out or excluded?
- Is migration or cleanup work absent?
- Is the file shorter than the docs it points to?

## Example

See `TELEMETRY.md` for this repository's concrete map.

## References

- OpenTelemetry semantic conventions
- Backend docs for the configured log/error/trace store
