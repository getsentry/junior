# Structured Logging Spec (OpenTelemetry Semantic Conventions)

## Metadata

- Created: 2026-02-24
- Last Edited: 2026-06-09

## Purpose

Define the canonical structured logging contract for application events, context propagation, and redaction.

## Scope

- Application logging APIs and event naming.
- Attribute key semantics and sanitization.
- Context propagation and compatibility shims.

## Related Specs

- [Instrumentation Specs](./instrumentation.md)
- [OpenTelemetry Semantics Map](./otel-semantics.md)
- [Tracing Spec](./tracing.md)

## Goals

- Make logs consistent, structured, and queryable across the app.
- Use OpenTelemetry semantic attribute names wherever a standard exists.
- Keep one logging entrypoint (similar to `ash`'s centralized logging model).
- Guarantee trace/log correlation for request and AI workflow debugging.
- Remove repeated per-request/per-turn attributes from log callsites by defaulting to ambient context propagation.

## Non-goals

- Replacing Sentry tracing setup.
- Shipping a separate log backend in this phase.

## Design Principles

- Centralized API: no direct `console.*` for application logging.
- Event-first logging: stable `event.name` for every log record.
- Semantic-first attributes: use OTel keys first; app keys are namespaced as `app.*`.
- Context propagation: request and workflow context auto-attached to child logs.
- Safe by default: redact sensitive values, drop oversized payloads, and keep logs JSON-safe.
- Canonical semantic key choices are documented in `specs/otel-semantics.md`.

## Logging Contract

### Record Shape

Each emitted log record follows this logical shape (transport can vary):

- `timestamp`
- `severity_text` (`DEBUG|INFO|WARN|ERROR`)
- `body` (human-readable summary)
- `event.name` (stable machine event id)
- `attributes` (flat key-value map, semantic keys preferred)
- `trace_id` (if active span)
- `span_id` (if active span)

### Message Semantics

- Every log record must include both:
  - `event.name`: stable snake_case identifier for machines, dashboards, and alert rules.
  - `body`: natural-language message for humans.
- `event.name` is the canonical grouping/filter key in tooling.
- `body` should follow plain language semantics:
  - concise
  - specific
  - past/present tense factual statement (not a promise)
  - no ambiguous placeholders like "something failed"
- Do not use `event.name` as a prose sentence and do not omit `event.name` in favor of only text.

### API Surface (`packages/junior/src/chat/logging.ts`)

- `log.debug(eventName, attrs?, body?)`
- `log.info(eventName, attrs?, body?)`
- `log.warn(eventName, attrs?, body?)`
- `log.error(eventName, attrs?, body?)`
- `log.exception(eventName, error, attrs?, body?)`
- `withLogContext(context, fn)` using `AsyncLocalStorage`
- `createLogContextFromRequest(...)`

Compatibility shims in `packages/junior/src/chat/logging.ts` remain supported:

- `logInfo(eventName, context?, attributes?, body?)`
- `logWarn(eventName, context?, attributes?, body?)`
- `logError(eventName, context?, attributes?, body?)`
- `logException(error, eventName, context?, attributes?, body?)`
- `withContext(context, fn)`

Context passed directly to compatibility shims is optional and merged with ambient context.

### Ambient Context Contract

Context is attached in layered order and merged into a single flat attribute map:

- `request_context`
  - Long-lived per incoming request context (for example request ID, HTTP route, platform).
- `operation_context`
  - Per turn/workflow/span context (for example Slack thread/user/channel, workflow run, model).
- `log_call_attributes`
  - Per-event attributes passed at log callsites.

Merge precedence (highest wins):

1. `log_call_attributes`
2. `operation_context`
3. `request_context`

Rules:

- Explicit per-log context/attributes remain allowed, but should be used only for event-local data.
- Baseline request/turn keys should be bound once via ambient context instead of repeated in every call.
- When keys collide, higher precedence overwrites lower precedence; duplicate keys are not emitted.

### Console Rendering Policy

- Structured records remain rich for sinks and Sentry; console rendering may project a smaller view for readability.
- Default dev console output should keep a small stable core (`event.name`, conversation correlation, trace/span ids, and event-local outcome fields) and suppress low-value ambient fields that are repeated on nearly every line.
- Default console output should suppress duplicated correlation fields when a stronger telemetry pivot is already present.
- Development console output may render a human-oriented summary line instead of the full key/value projection, as long as structured attributes remain intact for non-console sinks and `JUNIOR_LOG_FORMAT=structured` can force the full projection. This explicitly applies to worker-based dev runtimes that do not expose TTY state to the logging process.
- Large payload attributes should be compacted for `debug` and `info` console output using short previews plus length metadata. `warn` and `error` console output may retain fuller payload detail subject to normal redaction/truncation rules.
- Console projection is a presentation concern only; it must not remove the underlying structured attributes from emitted log records.

### Tool Lifecycle Logging

- Success-path tool execution is primarily traced via spans and span attributes.
- Do not emit both `agent_tool_call_started` and `agent_tool_call_completed` info logs for ordinary successful tool executions.
- Keep log events for failures, invalid input, auth interruptions, and other unusual tool states where a discrete log record adds value beyond the span.

### Runtime Constraints

- Ambient context propagation relies on Node `AsyncLocalStorage`.
- API routes that rely on ambient context must run in Node runtime.
- If Edge runtime logging is introduced later, it needs a separate propagation strategy.

## Event Naming Convention

- `snake_case` identifiers.
- Format: `<domain>_<action>[_<result>]`.
- Examples:
  - `webhook_platform_unknown`
  - `webhook_handler_failed`
  - `attachment_resolution_failed`
  - `ai_finalization_forced`
  - `skill_frontmatter_invalid`

## OpenTelemetry Semantic Attribute Policy

### Required (when available)

- `service.name`
- `service.version`
- `deployment.id`
- `deployment.environment.name`
- `event.name`

### HTTP / Request

- `http.request.method`
- `url.path`
- `url.full` (when safe)
- `http.response.status_code`
- `user_agent.original` (if available)

### Messaging / Slack

- `messaging.system` = `slack`
- `messaging.destination.name` (channel identifier)
- `messaging.message.id` (message ts/id when available)
- `messaging.message.conversation_id` (thread id)
- `enduser.id` (actor user id)

### GenAI

- `gen_ai.request.model`
- `gen_ai.provider.name` (provider/gateway)
- `gen_ai.operation.name` (e.g. `chat`, `invoke_agent`, `execute_tool`)
- `gen_ai.response.finish_reasons` (when available)
- `gen_ai.system_instructions` (when captured and provided separately)
- `gen_ai.input.messages` (serialized request messages when captured)
- `gen_ai.output.messages` (serialized model output messages when captured)
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (when available)
- `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_creation.input_tokens` (when available)
- `gen_ai.tool.description` (for tool-call spans when available)
- `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` (for tool-call spans when captured)

### Error

- `error.type`
- `exception.message`
- `exception.stacktrace` (only on error-level logs/events; truncated)

### Workflow / App-specific (namespaced)

Only when no semantic key exists:

- `app.workflow.run_id`
- `app.skill.name`
- `app.retry.attempt`

## Attribute Rules

- Flat map only; no nested objects.
- Value types: string | number | boolean | array of strings.
- `undefined`, `null`, empty string dropped.
- Arrays should be used only when a semantic convention explicitly expects repeated values (for example HTTP headers).
- Large strings truncated with suffix `...`.

## Redaction Rules

- Redact known secret/token patterns before emission.
- Never log raw auth headers, API keys, or attachment bytes.
- For user content, log size/metadata by default; content only when explicitly needed and safe.

## Metrics Derivation Policy

- Default: derive metrics from log events and their attributes.
- `event.name` is the primary metric grouping key.
- Avoid direct metric emission when equivalent counters/histograms can be computed from existing logs.
- Introduce direct metrics only when log/span derivation is insufficient due to:
  - very high-frequency signals and storage/query cost limits,
  - missing attributes that cannot be safely added to logs/spans,
  - or strict low-latency alert requirements.

## Acceptance Criteria

- 100% of application logs go through `packages/junior/src/chat/logging.ts`.
- 0 mixed key style for migrated callsites (no `media_type` / ad-hoc keys).
- Every warning/error log has stable `event.name` and semantic attributes.
- Every emitted log has both structured `event.name` and human-readable `body`.
- Request/thread/user/model context appears automatically in child logs.
- Secret redaction tests pass.

## Decision Record

- Adopt LogTape as the internal logging backend in `packages/junior/src/chat/logging.ts`.
- Keep the repo-local logging facade (`logInfo`, `logWarn`, `logError`, `logException`, context helpers) as the only application logging API; call sites should not import LogTape directly.
- Keep `AsyncLocalStorage` as the ambient context carrier and provide it to LogTape via `contextLocalStorage`.
- Configure the LogTape backend lazily from the facade on first use; importing Junior logging must not reset or eagerly reconfigure process-global LogTape state.
- Keep a repo-local console formatter instead of LogTape's stock text formatters because Junior emits standalone structured properties (`event.name`, correlation ids, event-local attrs) that must remain visible without interpolating every property into the message template.
- Keep Sentry exception/event-id behavior project-owned so `logException(...): eventId` and error-reference generation remain stable.
