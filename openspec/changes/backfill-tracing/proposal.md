## Why

Tracing is a concrete runtime contract for Junior's agent loop, direct AI calls, tool execution, MCP dispatch, sandbox lifecycle, and error/status semantics. The existing prose spec documents intended span names and attributes, while code and tests verify several important paths. Backfilling `tracing` into OpenSpec makes span ownership and verification boundaries explicit.

## What Changes

- Add a `tracing` OpenSpec capability baseline.
- Specify span lifecycle boundaries, naming, semantic attributes, GenAI spans, tool spans, MCP spans, sandbox spans, error/status behavior, and payload safety.
- Record prior art, implementation evidence, known gaps, and verification coverage.
- Do not change tracing implementation.

## Capabilities

### New Capabilities

- `tracing`: Defines Junior's span and trace contract.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec artifacts under `openspec/changes/backfill-tracing/`.
- Leaves shared observability policy to `instrumentation`, logging events to `logging`, and key selection to `otel-semantics`.
