# Observability

Telemetry exists for diagnosis and operations. It is not a product behavior
contract and should not drive mocks or assertions outside instrumentation tests.

## Signals

- Logs describe discrete events and decisions.
- Spans describe timed work and causal relationships.
- Errors represent actionable failures, not normal control flow.
- Metrics should derive from stable events or spans when practical rather than
  duplicate bespoke instrumentation.

## Naming And Attributes

- Use OpenTelemetry semantic attributes when one exists.
- Use `app.*` for Junior-owned attributes.
- Keep operation names stable and low-cardinality.
- Record correlation identifiers such as conversation, run, task, plugin,
  provider, and sandbox session IDs when they are relevant and safe.
- Do not encode identifiers or user-controlled values into span operation names.
- Set error status and capture exceptions at the boundary that owns the failure.

## Ownership

- Instrumentation belongs at real runtime boundaries: ingress, queue dispatch,
  worker execution, agent runs, provider requests, sandbox creation and egress,
  plugin hooks, and delivery.
- Lower-level helpers should return errors rather than independently capture the
  same failure.
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
