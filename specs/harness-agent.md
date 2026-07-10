# Harness Agent Spec

## Metadata

- Created: 2026-02-24
- Last Edited: 2026-07-10

## Purpose

Define the canonical runtime contract for assistant-turn execution and user-visible Slack replies.

## Scope

- Turn execution in `executeAgentRun(...)`.
- Assistant text streaming and final output resolution.
- Diagnostics emitted for each turn.

## Non-Goals

- Defining provider-specific OAuth or credential policy.
- Defining tool-targeting rules beyond references to the context-bound tooling spec.

## Runtime Contract

### Loop model

- Use `Agent` from `@earendil-works/pi-agent-core` for reply generation.
- For normal turns, instantiate a fresh Pi agent with the static system prompt, restore durable conversation-level Pi message history, then prompt only the current turn.
- Persist updated conversation-level Pi message history only after the final visible reply is delivered by the runtime.
- Per-turn runtime context may be included in the current user prompt for generation, but it must not be stored in durable conversation-level Pi history after completion.
- Use bounded execution with `AGENT_TURN_TIMEOUT_MS` and explicit `agent.abort()` on timeout.
- Completion is based on assistant text output; there is no classifier-driven continuation loop.

### Thinking-level routing

- Route each main assistant turn through the fast thinking classifier before creating the Pi `Agent`.
- The classifier may run with low thinking because it is a bounded routing task; the selected main-turn level is independent.
- The default and failure fallback for substantive work is medium effort, which is the normal assistant reasoning level.
- Use `none` only for greetings, acknowledgments, and turns that need no substantive assistant work.
- Use `low` rarely, only for deterministic one-step answers or transformations with no tools, no current or external facts, no prior thread-context interpretation, and no source verification.
- Use `medium` for ordinary assistant work, including explanations, source-backed checks, thread follow-ups, likely tool use, ambiguity, or multi-step analysis.
- Use `high` for code changes, debugging/root-cause analysis, research-heavy work, non-trivial drafting, or explicit requests to be thorough.
- Prior thread context and current-turn attachment/source blocks floor non-`none` selections at medium so short follow-ups and source-backed turns do not run with shallow reasoning.

### Timeout behavior

- `executeAgentRun(...)` aborts the Pi agent on timeout and waits for the in-flight prompt/continue call to settle before inspecting Pi messages.
- When the owning host request is cancelled, `executeAgentRun(...)` aborts the active Pi call and any pending provider retry backoff.
- When resumability context is available (`conversation_id` + `session_id`) and a safe-boundary session record can be persisted, timeout throws `RetryableTurnError("agent_continue")` with session record metadata instead of returning a normal reply payload.
- When no resumable session record can be persisted, timeout falls back to the standard provider-error reply path.
- The harness does not decide whether timed-out work should be auto-resumed after user-visible output has started. Higher-level runtime code applies the visibility rules from [Agent Session Resumability Spec](./agent-session-resumability.md).

### Terminal output contract

- Final reply text is assembled from assistant messages after the last tool-result message, joined by `"\n"` and trimmed.
- Provisional assistant narration emitted before tool execution does not count as terminal user-visible output.
- If assistant text is empty, return `buildExecutionFailureMessage(toolErrorCount)`.
- If assistant text is an execution-escape or raw tool payload shape, return `buildExecutionFailureMessage(toolErrorCount)`.
- This harness-level contract only defines generation output. Chat runtimes may still treat the turn as failed if final user-visible reply delivery fails.

### Streaming contract

- Stream `message_update`/`text_delta` events from the Pi `Agent`.
- Insert `"\n"` between text from consecutive assistant messages to match final non-streamed join behavior.
- Streaming callback failures are logged and do not fail the harness turn by themselves.
- Final reply delivery is a separate runtime concern and may still determine whether the outer Slack turn succeeds.

### Visibility rules

- Tool calls and tool results are internal execution artifacts and are not directly posted as user replies.
- Slack status updates are progress UX only and are not terminal output.
- User-visible output is the resolved assistant markdown text (or execution-failure fallback text).

### Tool semantics

- Tools execute as intermediate actions (`bash`, `readFile`, `webSearch`, Slack tools, skill loading, etc.).
- Model-repairable tool failures must follow the [Agent Execution Discipline Spec](./agent-execution.md) tool-failure contract so Pi records them as `toolResult.isError=true`.
- The turn is successful when assistant text resolves to a non-empty, non-escape final response.
- Slack runtimes refine that further: turn completion is only persisted after the final visible reply is delivered.
- Context-bound target ownership remains runtime/harness-owned. See [Harness Tool Context Spec](./harness-tool-context.md).

## Failure Model

1. Provider/runtime exception in turn execution returns `Error: <message>` and `provider_error` diagnostics.
2. Empty assistant text returns an explicit execution-failure fallback message.
3. Tool-shaped or execution-deferral assistant text returns an explicit execution-failure fallback message.
4. Timeout always aborts the turn and is logged with timeout diagnostics.
5. Timeout may throw retryable resume metadata instead of returning a provider-error reply when a safe resumable session record exists.

## Observability

- Every assistant turn must annotate active spans with turn diagnostics after generation completes.
- Required attributes when available:
  - `gen_ai.request.model`
  - `gen_ai.request.reasoning.level` (when requested)
  - `gen_ai.provider.name`
  - `gen_ai.operation.name`
  - `gen_ai.input.messages`
  - `gen_ai.output.messages`
  - `gen_ai.usage.input_tokens`
  - `gen_ai.usage.output_tokens` / `gen_ai.usage.total_tokens`
  - `gen_ai.usage.input_tokens.cached` (when available)
  - `gen_ai.usage.input_tokens.cache_write` (when available)
  - `app.ai.outcome` (`success|execution_failure|provider_error`)
  - `app.ai.assistant_messages`
  - `app.ai.tool_results`
  - `app.ai.tool_error_results`
  - `app.ai.used_primary_text`
  - `gen_ai.response.finish_reasons` (when available)
  - `exception.message` (when available)
- Do not emit empty placeholders for absent optional attributes.

## Verification

1. Unit/integration tests verify newline-joined assistant output and empty-response fallback behavior.
2. Timeout path emits `agent_turn_timeout` and either throws retryable agent continuation metadata or returns provider-error diagnostics when no safe session record can be persisted.
3. Eval and integration runs observe span diagnostics for each turn.

## Related Specs

- [Harness Tool Context Spec](./harness-tool-context.md)
- [Agent Execution Discipline Spec](./agent-execution.md)
- [Agent Session Resumability Spec](./agent-session-resumability.md)
- [Security Policy](./security-policy.md)
- [Tracing Spec](./tracing.md)
