## Why

Structured logging is a runtime contract in Junior: it controls event names, context propagation, trace correlation, redaction, Sentry exception capture, Chat SDK log bridging, and console rendering. The existing `specs/logging.md` is strong prose, but it needs an OpenSpec baseline with concrete requirements and scenarios.

## What Changes

- Add a `logging` OpenSpec capability baseline.
- Specify log record shape, facade ownership, event naming, context merge precedence, semantic attributes, redaction, console rendering, tool lifecycle logging, exception capture, and compatibility shims.
- Record prior art and local verification coverage.
- Do not change logging implementation.

## Capabilities

### New Capabilities

- `logging`: Defines Junior's structured logging contract.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec artifacts under `openspec/changes/backfill-logging/`.
- Keeps detailed span behavior in the `tracing` capability and shared signal policy in `instrumentation`.
