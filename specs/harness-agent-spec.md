# Harness Agent Spec

## Metadata

- Created: 2026-02-24
- Last Edited: 2026-04-13

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-05: Linked to canonical session resumability contract for multi-slice timeout recovery.
- 2026-04-06: Switched stop-reason observability to `gen_ai.response.finish_reasons`.
- 2026-04-13: Clarified timeout behavior when turn-session checkpoints are available for resumable slices.

## Status

Active

## Purpose

Define the canonical runtime contract for assistant-turn execution and user-visible Slack replies.

## Scope

- Turn execution in `generateAssistantReply(...)`.
- Assistant text streaming and final output resolution.
- Diagnostics emitted for each turn.

## Non-Goals

- Defining provider-specific OAuth or credential policy.
- Defining tool-targeting rules beyond references to the context-bound tooling spec.

## Runtime Contract

### Loop model

- Use `Agent` from `@mariozechner/pi-agent-core` for reply generation.
- Use bounded execution with `AGENT_TURN_TIMEOUT_MS` and explicit `agent.abort()` on timeout.
- Completion is based on assistant text output; there is no classifier-driven continuation loop.

### Timeout behavior

- `generateAssistantReply(...)` aborts the Pi agent on timeout and waits for the in-flight prompt/continue call to settle before inspecting Pi messages.
- When resumability context is available (`conversation_id` + `session_id`) and a safe-boundary checkpoint can be persisted, timeout throws `RetryableTurnError("turn_timeout_resume")` with checkpoint metadata instead of returning a normal reply payload.
- When no resumable checkpoint can be persisted, timeout falls back to the standard provider-error reply path.
- The harness does not decide whether timed-out work should be auto-resumed after user-visible output has started. Higher-level runtime code applies the visibility rules from [Agent Session Resumability Spec](./agent-session-resumability-spec.md).

### Terminal output contract

- Final reply text is assembled from assistant messages joined by `"\n"` and trimmed.
- If assistant text is empty, return `buildExecutionFailureMessage(toolErrorCount)`.
- If assistant text is an execution-escape or raw tool payload shape, return `buildExecutionFailureMessage(toolErrorCount)`.

### Streaming contract

- Stream `message_update`/`text_delta` events from the Pi `Agent`.
- Insert `"\n"` between text from consecutive assistant messages to match final non-streamed join behavior.
- Streaming failures in delivery callbacks are logged and do not fail the turn.

### Visibility rules

- Tool calls and tool results are internal execution artifacts and are not directly posted as user replies.
- Slack status updates are progress UX only and are not terminal output.
- User-visible output is the resolved assistant markdown text (or execution-failure fallback text).

### Tool semantics

- Tools execute as intermediate actions (`bash`, `readFile`, `webSearch`, Slack tools, skill loading, etc.).
- The turn is successful when assistant text resolves to a non-empty, non-escape final response.
- Context-bound target ownership remains runtime/harness-owned. See [Harness Tool Context Spec](./harness-tool-context-spec.md).

## Failure Model

1. Provider/runtime exception in turn execution returns `Error: <message>` and `provider_error` diagnostics.
2. Empty assistant text returns an explicit execution-failure fallback message.
3. Tool-shaped or execution-deferral assistant text returns an explicit execution-failure fallback message.
4. Timeout always aborts the turn and is logged with timeout diagnostics.
5. Timeout may throw retryable resume metadata instead of returning a provider-error reply when a safe resumable checkpoint exists.

## Observability

- Every assistant turn must annotate active spans with turn diagnostics after generation completes.
- Required attributes when available:
  - `gen_ai.request.model`
  - `gen_ai.provider.name`
  - `gen_ai.operation.name`
  - `gen_ai.input.messages`
  - `gen_ai.output.messages`
  - `gen_ai.usage.input_tokens`
  - `gen_ai.usage.output_tokens`
  - `app.ai.outcome` (`success|execution_failure|provider_error`)
  - `app.ai.assistant_messages`
  - `app.ai.tool_results`
  - `app.ai.tool_error_results`
  - `app.ai.used_primary_text`
  - `gen_ai.response.finish_reasons` (when available)
  - `error.message` (when available)
- Do not emit empty placeholders for absent optional attributes.

## Verification

1. Unit/integration tests verify newline-joined assistant output and empty-response fallback behavior.
2. Timeout path emits `agent_turn_timeout` and either throws retryable timeout-resume metadata or returns provider-error diagnostics when checkpointing is unavailable.
3. Eval and integration runs observe span diagnostics for each turn.

## Related Specs

- [Harness Tool Context Spec](./harness-tool-context-spec.md)
- [Agent Session Resumability Spec](./agent-session-resumability-spec.md)
- [Security Policy](./security-policy.md)
- [Tracing Spec](./logging/tracing-spec.md)
