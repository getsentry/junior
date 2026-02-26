# OpenTelemetry Semantics Map

This file is the canonical attribute and naming map for instrumentation in this repo.

## Policy
- Use OpenTelemetry semantic conventions first.
- Use `app.*` only when no semantic key exists.
- When a semantic convention is Development status, prefer semantic keys anyway for interoperability and document any `app.*` fallback.

## Core Context
- `service.name`
- `service.version`
- `deployment.environment.name`
- `trace_id`
- `span_id`

## HTTP Server
- Span name: `http.server.request`
- Span op: `http.server`
- Attributes:
  - `http.request.method`
  - `url.path`
  - `http.response.status_code`

## Messaging / Slack
- `messaging.system`
- `messaging.destination.name`
- `messaging.conversation.id`
- `messaging.message.id` (when available)
- `enduser.id`

## GenAI
- `gen_ai.system`
- `gen_ai.operation.name`
- `gen_ai.request.model`

## Process / CLI Execution
- Span name SHOULD be executable name when possible (for example `bash`).
- Span attributes:
  - `process.executable.name`
  - `process.exit.code`
  - `process.pid` when available from runtime/tooling
  - `process.command_args` when safe and non-sensitive
  - `error.type` when `process.exit.code != 0`
- Status:
  - span status is canonical success/failure signal.

### Current Runtime Limits
- Current sandbox execution integration does not expose `process.pid`.
- Raw command arguments are user-provided and may contain sensitive values; do not emit them by default.

### Process / CLI Custom Fallbacks
Use `app.*` only for data with no current semantic key:
- `app.sandbox.stdout_bytes`
- `app.sandbox.stderr_bytes`
- `app.sandbox.sync.files_written`
- `app.sandbox.sync.bytes_written`

## Error Semantics
- `error.type` for low-cardinality error class.
- `error.message` and `error.stack` only when needed and safe.

## Naming Rules
- Span names: low-cardinality.
- Event names: `snake_case`.
- `op` values: dotted domain categories (for example `http.server`, `gen_ai.generate_text`, `sandbox.sync`).
