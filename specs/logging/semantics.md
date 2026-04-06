# OpenTelemetry Semantics Map

## Metadata

- Created: 2026-02-25
- Last Edited: 2026-04-06

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-06: Added sandbox snapshot lifecycle attribute mappings.
- 2026-04-06: Added official GenAI finish-reason, system-instructions, and tool-description semantics.

## Status

Active

## Purpose

Provide the canonical semantic attribute and naming map used by logging and tracing specs.

## Scope

- Preferred OpenTelemetry keys.
- `app.*` fallback policy when semantic keys do not exist.
- Naming rules for spans, events, and operation categories.

## Related Specs

- [Instrumentation Specs](./index.md)
- [Structured Logging Spec](./logging-spec.md)
- [Tracing Spec](./tracing-spec.md)

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
- `messaging.message.conversation_id`
- `messaging.message.id` (when available)
- `enduser.id`

## GenAI

- `gen_ai.provider.name`
- `gen_ai.operation.name`
- `gen_ai.request.model`
- `gen_ai.response.finish_reasons` (when available)
- `gen_ai.system_instructions` (when captured and provided separately from chat history)
- `gen_ai.input.messages` (when captured)
- `gen_ai.output.messages` (when captured)
- `gen_ai.usage.input_tokens` (when available)
- `gen_ai.usage.output_tokens` (when available)
- `gen_ai.tool.description` (when available)
- `gen_ai.tool.name` (for `execute_tool`)
- `gen_ai.tool.call.id` (when available)
- `gen_ai.tool.call.arguments` (when captured)
- `gen_ai.tool.call.result` (when captured)
- Prefer `gen_ai.input.messages` / `gen_ai.output.messages` over legacy names like `gen_ai.request.messages` / `gen_ai.response.text`.
- Prefer `gen_ai.response.finish_reasons` over custom `app.ai.stop_reason`.

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
- `app.sandbox.snapshot.cache_hit`
- `app.sandbox.snapshot.resolve_outcome`
- `app.sandbox.snapshot.rebuild_reason`
- `app.sandbox.snapshot.profile_hash`
- `app.sandbox.snapshot.dependency_count`
- `app.sandbox.snapshot.rebuild_after_missing`
- `app.sandbox.snapshot.install.system_count`
- `app.sandbox.snapshot.install.npm_count`

## Error Semantics

- `error.type` for low-cardinality error class.
- `error.message` and `exception.stacktrace` only when needed and safe.

## Naming Rules

- Span names: low-cardinality.
- Event names: `snake_case`.
- `op` values: dotted domain categories (for example `http.server`, `gen_ai.invoke_agent`, `sandbox.sync`).
