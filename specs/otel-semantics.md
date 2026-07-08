# OpenTelemetry Semantics Map

## Metadata

- Created: 2026-02-25
- Last Edited: 2026-06-09

## Purpose

Provide the canonical semantic attribute and naming map used by logging and tracing specs.

## Scope

- Preferred OpenTelemetry keys.
- `app.*` fallback policy when semantic keys do not exist.
- Naming rules for spans, events, and operation categories.

## Related Specs

- [Instrumentation Specs](./instrumentation.md)
- [Structured Logging Spec](./logging.md)
- [Tracing Spec](./tracing.md)

This file is the canonical attribute and naming map for instrumentation in this repo.

## Policy

- Use OpenTelemetry semantic conventions first.
- Use `app.*` only when no semantic key exists.
- When a semantic convention is Development status, prefer semantic keys anyway for interoperability and document any `app.*` fallback.

## Core Context

- `service.name`
- `service.version`
- `deployment.id`
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

- `gen_ai.conversation.id`
- `gen_ai.provider.name`
- `gen_ai.operation.name`
- `gen_ai.request.model`
- `gen_ai.request.reasoning.level` (when requested)
- `gen_ai.output.type`
- `gen_ai.request.stream`
- `gen_ai.response.finish_reasons` (when available)
- `server.address`
- `server.port` when `server.address` is set
- `gen_ai.system_instructions` (when captured and provided separately from chat history)
- `gen_ai.input.messages` (when captured)
- `gen_ai.output.messages` (when captured)
- `gen_ai.usage.input_tokens` (when available)
- `gen_ai.usage.output_tokens` (when available)
- `gen_ai.usage.total_tokens` (when available)
- `gen_ai.usage.input_tokens.cached` (when available)
- `gen_ai.usage.input_tokens.cache_write` (when available)
- `gen_ai.tool.description` (when available)
- `gen_ai.tool.name` (for `execute_tool`)
- `gen_ai.tool.type` (when available)
- `gen_ai.tool.call.id` (when available)
- `gen_ai.tool.call.arguments` (when captured)
- `gen_ai.tool.call.result` (when captured)
- Prefer `gen_ai.input.messages` / `gen_ai.output.messages` over legacy names like `gen_ai.request.messages` / `gen_ai.response.text`.
- Prefer `gen_ai.response.finish_reasons` over custom `app.ai.stop_reason`.
  Normalize Pi's `toolUse` stop reason to `tool_use` at telemetry boundaries.

### GenAI Custom Fallbacks

Use `app.*` for bounded, non-content metadata with no current semantic key:

- `app.conversation.privacy` (`public|private`)
- `app.ai.input.message_count`
- `app.ai.input.content_chars`
- `app.ai.input.roles`
- `app.ai.input.part_types`
- `app.ai.output.message_count`
- `app.ai.output.content_chars`
- `app.ai.output.roles`
- `app.ai.output.part_types`
- `app.ai.system_instructions.content_chars`
- `app.ai.tool.call.arguments.type`
- `app.ai.tool.call.arguments.size_chars`
- `app.ai.tool.call.arguments.keys`
- `app.ai.tool.call.result.type`
- `app.ai.tool.call.result.size_chars`
- `app.ai.tool.call.result.keys`

Raw GenAI payload attributes are governed by `./data-redaction-policy.md`.
Private conversations must use metadata-only attributes.

## MCP Tool Calls

- `mcp.method.name`
- `mcp.protocol.version`
- `mcp.session.id`
- `mcp.resource.uri` when applicable under explicit opt-in
- `jsonrpc.protocol.version`
- `jsonrpc.request.id`
- `rpc.response.status_code`
- `gen_ai.operation.name` (`execute_tool` for tool calls)
- `gen_ai.tool.name`
- `gen_ai.tool.type` when available
- `gen_ai.tool.call.arguments` only under explicit capture policy
- `gen_ai.tool.call.result` only under explicit capture policy
- `network.protocol.name`
- `network.protocol.version`
- `network.transport`
- `server.address`
- `server.port`

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

- `app.file.id`
- `app.file.mime_type`
- `app.file.skill_directory`
- `app.file.candidates`
- `app.file.directories`
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
- `exception.message` and `exception.stacktrace` only when needed and safe.

## Naming Rules

- Span names: low-cardinality.
- Event names: `snake_case`.
- `op` values: dotted domain categories (for example `http.server`, `gen_ai.invoke_agent`, `sandbox.sync`).
