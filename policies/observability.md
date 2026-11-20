# Observability

## Intent

Telemetry is for diagnosis and operations. It is not a product behavior
contract. `../TELEMETRY.md` holds telemetry names, investigation pivots, and query
recipes.

## Policy

### Signals

- Logs record discrete events and decisions. Spans record timed work and
  causality. Errors record actionable failures, not normal control flow.
- Derive metrics from stable events or spans when practical.

### Names

- Use OpenTelemetry semantic attributes when one exists. Use `app.*` for
  Junior attributes.
- Do not add app-specific keys under `user.*`. Put request facts in `app.*`.
- Use singular nouns (`message`, `tool_call`). Use a plural only for a batch
  or a canonical external term (`embeddings`).
- The last segment of an event name is the outcome: a past participle for a
  transition (`started`, `completed`, `failed`, `rejected`, `skipped`,
  `requeued`), a present participle for work in progress (`retrying`), or a
  state term (`busy`, `empty`, `missing`, `invalid`, `provider_error`). Never
  a base verb (`retry`) or direction (`in`, `out`).
- Prefer the shared outcomes: `started`, `completed`, `failed`, `exception`,
  `timed_out`, `retrying`, `exhausted`, `rejected`, `denied`, `skipped`.
- Use `.failed` for an unsuccessful outcome, including a captured exception.
  Use `.exception` only where a top-level handler catches an exception that
  no owner handled.
- Event and span names are stable and low-cardinality. Put ids, provider
  names, and user values in attributes.
- Record safe correlation ids (conversation, run, task, plugin, provider,
  sandbox session) when relevant.

### Emission

- Emit a stable event name plus attributes. Do not add a duplicate
  human-readable message.
- Bind request, conversation, actor, destination, and run correlation once at
  the operation edge. Nested logs inherit it.
- Async log context is not durable. Queues, callbacks, and resumed work carry
  context explicitly and bind it again.
- Adapters may keep free-form provider messages as safe attributes, never as
  event names.
- Backend adapters own compatibility views such as Sentry `event.name`.

### Ownership

- Instrument real edges: ingress, queue dispatch, workers, agent runs,
  provider requests, sandbox creation and egress, plugin hooks, delivery.
- Set error status and capture exceptions at the edge that owns the failure.
  Lower helpers return errors.
- Record retry attempts without reporting each transient attempt as terminal.
- Telemetry adapters must not change behavior when telemetry is unavailable.
- Record safe metadata only. Follow `data-redaction.md`.

### Tests

- Only instrumentation tests assert event names, span links, attributes, and
  error ownership. Product tests assert outcomes.

## Exceptions

- None.
