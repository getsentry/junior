# Instrumentation Specs

## Metadata

- Created: 2026-02-25
- Last Edited: 2026-06-05

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

## Testing Policy

- Instrumentation is part of the real runtime path. Do not mock or disable Sentry capture, logging, span capture, or tracing helpers in ordinary behavior tests.
- Behavior tests should not assert log calls, span creation, trace attributes, or Sentry captures. Let telemetry run unless the emitted signal is the product contract under test.
- Instrumentation contract tests should be rare. They may replace Sentry/span primitives with a small test double only when the test's purpose is to inspect emitted semantic keys, parent/child span behavior, error status, or capture return behavior.
- Keep instrumentation contract tests dedicated and clearly named under `tests/unit/logging/**`. Do not mix telemetry call assertions into product behavior suites or feature-local `*instrumentation*.test.ts` files.
- If product code consumes a telemetry result, such as a Sentry event ID, test the resulting user-visible behavior or persisted state through an explicit service port. Avoid global telemetry module mocks for full runtime flows.

## Specs

- [Structured Logging Spec](./logging.md)
- [Tracing Spec](./tracing.md)
- [Semantics Map](./otel-semantics.md)

## Operational Guides (Non-Normative)

- [Reliability Runbooks](../packages/docs/src/content/docs/operate/reliability-runbooks.md)
- [Observability](../packages/docs/src/content/docs/operate/observability.md)
