# Instrumentation Specs

## Metadata

- Created: 2026-02-25
- Last Edited: 2026-03-06

## Purpose

Define the canonical logging/tracing instrumentation contracts and shared policy for this repository.

## Scope

- Logging standards: event naming, attribute keys, redaction, and correlation.
- Tracing standards: span boundaries, span naming, required attributes, and error semantics.

## Metrics Policy

- Default: derive metrics from spans and logs.
- Do not add direct metric emission if an equivalent signal can be computed from existing log events or span attributes.
- Direct metrics are only justified when:
  - event frequency is too high for practical log/span retention or query costs,
  - required aggregation cannot be recovered from existing span/log attributes, or
  - a critical SLO/SLA alert needs a dedicated low-latency metric path.

## Specs

- [Structured Logging Spec](./logging.md)
- [Tracing Spec](./tracing.md)
- [Semantics Map](./otel-semantics.md)

## Operational Guides (Non-Normative)

- [Reliability Runbooks](../packages/docs/src/content/docs/operate/reliability-runbooks.md)
- [Observability](../packages/docs/src/content/docs/operate/observability.md)
