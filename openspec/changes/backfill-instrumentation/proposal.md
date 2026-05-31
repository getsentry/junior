## Why

`specs/instrumentation.md` is the observability entry point for Junior, but today it is an index plus shared policy rather than an OpenSpec capability. The repo needs a baseline capability that defines how logging, tracing, semantic attributes, and metrics policy fit together without duplicating the detailed logging/tracing specs.

## What Changes

- Add an `instrumentation` OpenSpec capability for shared observability ownership.
- Specify boundaries between instrumentation, logging, tracing, and OpenTelemetry semantic mapping.
- Capture prior art from OpenTelemetry, Sentry, and LogTape.
- Record verification coverage and open questions for metrics, context propagation, and direct metric exceptions.
- Do not change runtime instrumentation code.

## Capabilities

### New Capabilities

- `instrumentation`: Defines shared observability policy, capability ownership, signal correlation, and metrics derivation rules.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec artifacts under `openspec/changes/backfill-instrumentation/`.
- Leaves detailed requirements for `logging`, `tracing`, and `otel-semantics` to their dedicated backfill changes.
