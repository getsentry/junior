# Tracing Spec (OpenTelemetry + Sentry Spans)

## Goals
- Make span instrumentation consistent, queryable, and low-noise.
- Define stable span names and operations for workflow and sandbox lifecycle visibility.
- Preserve end-to-end correlation between spans, logs, and request/workflow context.
- Keep semantic key selection centralized in `docs/logging/semantics.md`.

## Non-goals
- Replacing existing Sentry SDK setup.
- Instrumenting every internal function or filesystem operation.

## Trace Model
- Prefer meaningful lifecycle boundaries over granular implementation spans.
- Root spans should represent user-visible workflows (for example `workflow.chat_turn`, `workflow.reply`, `ai.generate_assistant_reply`).
- Child spans should represent major sub-operations with distinct latency/failure characteristics.

## Naming Conventions
- Span names use `snake_case` domain/action naming.
- `op` values use dotted operation categories.
- Examples:
  - name: `workflow.reply`, op: `workflow.reply`
  - name: `ai.generate_assistant_reply`, op: `gen_ai.invoke_agent`
  - name: `sandbox.create`, op: `sandbox.create`

## Required Attributes

### Service / Deployment
- `service.name` (when available)
- `service.version` (when available)
- `deployment.environment.name` (when available)

### Correlation Context
- `messaging.message.conversation_id` / `app.workflow.run_id` / `enduser.id` when available.
- `messaging.destination.name` for channel context when available.
- `gen_ai.request.model` for model-level tracing.
- `gen_ai.input.messages` / `gen_ai.output.messages` when safely captured.
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` when available from provider responses.
- `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` on tool execution spans when captured.
- Keep existing context keys aligned with `src/chat/logging.ts` and `src/chat/observability.ts`.

### Error Attributes
- `error.type`
- `error.message`
- `exception.stacktrace` (when captured and safe)

## Attribute Policy
- Use OTel semantic keys first.
- Use `app.*` only when no semantic key exists.
- Keep attributes low-cardinality and bounded in size.
- Do not store raw sensitive payloads in span attributes.

## Metrics from Traces and Logs
- Default policy: derive operational metrics from spans and logs.
- Prefer deriving counters and latency histograms from:
  - span durations + status
  - log `event.name` + stable attributes
- Do not add direct metric emission when equivalent derivation is available.
- Direct metrics are reserved for high-frequency or otherwise non-recoverable signals.

## Error and Status Semantics
- Fail the span when the operation throws or returns a terminal failure condition.
- Record exceptions with structured error attributes when available.
- Swallowed/best-effort failures (for example keepalive extensions) should still be observable via span events/attributes when possible.

## Sandbox Span Standard

### Required Spans
- `sandbox.acquire` with `op: sandbox.acquire`
- `sandbox.get` with `op: sandbox.get` when reusing `sandboxId`
- `sandbox.create` with `op: sandbox.create` when provisioning
- `sandbox.sync_skills` with `op: sandbox.sync`
- `sandbox.bash_tool.init` with `op: sandbox.tool.init`
- `bash` with `op: process.exec` for sandbox command execution
- `sandbox.keepalive.extend` with `op: sandbox.keepalive` when keepalive is configured
- `sandbox.stop` with `op: sandbox.stop` during disposal

### Required Sandbox Attributes
- `app.sandbox.reused` (boolean)
- `app.sandbox.source` (`memory|id_hint|created`)
- `app.sandbox.timeout_ms` (number)
- `app.sandbox.runtime` (string)
- `app.sandbox.skills_count` (number)
- `app.sandbox.sync.files_written` (number)
- `app.sandbox.sync.bytes_written` (number)
- `process.executable.name` (string)
- `process.exit.code` (number)
- `process.pid` (number) when available
- `process.command_args` (string array) when safe and non-sensitive
- `error.type` when command exits non-zero
- `app.sandbox.stdout_bytes` (number)
- `app.sandbox.stderr_bytes` (number)

### Prohibited Sandbox Attributes
- Raw command text.
- File contents or attachment bodies.
- Unbounded high-cardinality per-file path attributes on spans.

## Parent/Child Relationships
- Sandbox spans should be nested under `ai.generate_assistant_reply` when invoked during reply generation.
- Sandbox execution spans should be nested under the active tool-call/request span context.

## Rollout Guidance
- Start with lifecycle + I/O spans.
- Avoid per-file child spans for skill synchronization in the initial rollout.
- Expand only when a specific observability gap is identified and justified.

## Acceptance Criteria
- Sandbox create/reuse/sync/execute timing is visible in traces.
- Span attributes are stable and low-cardinality.
- Trace and log correlation remains intact (`trace_id`, `span_id`, shared workflow attributes).
- No sensitive raw command or content payloads are emitted to spans.
