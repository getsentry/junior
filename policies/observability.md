# Observability

Telemetry exists for diagnosis and operations. It is not a product behavior
contract. It should not drive mocks or assertions outside instrumentation tests.

## Signals

- Logs describe discrete events and decisions.
- Spans describe timed work and causal relationships.
- Errors represent actionable failures, not normal control flow.
- Metrics should come from stable events or spans when practical rather than
  duplicate custom instrumentation.

## Naming And Attributes

- Use OpenTelemetry semantic attributes when one exists.
- Use `app.*` for Junior-owned attributes.
- Name events `<domain>.<operation>[.<suboperation>].<outcome>`, using lowercase
  dot-delimited namespaces and snake case only within a namespace component.
- Use singular count nouns for domains and operations (`message`, `tool_call`,
  `zebra`). Use a plural only when one event represents a collection or batch,
  or when keeping a canonical external term such as `embeddings`.
- The final component says what was observed:
  - Use a past participle for a completed transition: `started`, `completed`,
    `failed`, `accepted`, `rejected`, `skipped`, `requeued`, `yielded`.
  - Use a present participle only for work currently underway: `retrying`.
  - Use an adjective or established state term for an observation rather than a
    transition: `busy`, `empty`, `missing`, `invalid`, `provider_error`.
- Do not end event names with imperative or base verbs (`retry`, `start`,
  `unlink`) or directional shorthand (`in`, `out`). Event names describe
  observations, not commands.
- Event names identify one stable event structure. Never include identifiers,
  provider names, user-controlled values, or other occurrence-specific data in
  an event name. Record them as attributes.
- Prefer consistent outcomes such as `started`, `completed`, `failed`,
  `exception`, `timed_out`, `retrying`, `exhausted`, `rejected`, `denied`, and
  `skipped`. Use `.exception` for an actual captured exception and `.failed`
  for an unsuccessful domain outcome that may not be exceptional.
- Keep operation names stable and low-cardinality.
- Record correlation identifiers such as conversation, run, task, plugin,
  provider, and sandbox session IDs when they are relevant and safe.
- Do not encode identifiers or user-controlled values into span operation names.
- Set error status and capture exceptions at the edge that owns the failure.

## Emission

- Runtime code emits a stable event name plus occurrence-specific attributes.
  Do not duplicate the event with a human-readable message.
- Bind request, conversation, actor, destination, and run correlation once at
  the owning operation edge. Nested logs inherit that context and the active
  trace and span identifiers.
- Async log context is not durable runtime context. Queues, callbacks, resumed
  work, and other durable edges must carry authoritative context explicitly and
  bind it again when execution starts.
- Free-form messages received from providers, libraries, or plugins may be kept
  as safe attributes by their adapter. They are not event names.
- Backend adapters own compatibility views such as Sentry's `event.name`. The
  provider-neutral record owns the canonical event name.

## Ownership

- Instrumentation belongs at real runtime edges: ingress, queue dispatch, worker
  execution, agent runs, provider requests, sandbox creation and egress, plugin
  hooks, and delivery.
- Lower-level helpers should return errors rather than capture the same failure
  on their own.
- A retry records attempts without reporting every transient attempt as a
  distinct terminal failure.
- Logging and tracing adapters must not change runtime behavior when telemetry
  is unavailable.

## Data Safety

Follow `data-redaction.md`. Record safe metadata, not message content, prompts,
tool payloads, credentials, SQL values, or unrestricted provider responses.

## Verification

- Instrumentation tests may assert event names, span relationships, safe
  attributes, and error ownership.
- Product tests should assert the user-visible or durable outcome instead of
  logs, spans, status messages, or monitoring side effects.
- Operational query recipes and signal pivots live in `../TELEMETRY.md`.
