# Harness Agent Spec

## Metadata

- Created: 2026-02-24
- Last Edited: 2026-03-05

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-05: Linked to canonical session resumability contract for multi-slice timeout recovery.


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
4. Timeout aborts the turn and is logged with timeout diagnostics.

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
  - `app.ai.stop_reason` (when available)
  - `error.message` (when available)
- Do not emit empty placeholders for absent optional attributes.

## Verification

1. Unit/integration tests verify newline-joined assistant output and empty-response fallback behavior.
2. Timeout path emits `agent_turn_timeout` and returns provider error diagnostics.
3. Eval and integration runs observe span diagnostics for each turn.

## Related Specs

- [Harness Tool Context Spec](./harness-tool-context-spec.md)
- [Agent Session Resumability Spec](./agent-session-resumability-spec.md)
- [Security Policy](./security-policy.md)
- [Tracing Spec](./logging/tracing-spec.md)
