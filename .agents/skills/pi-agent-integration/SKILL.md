---
name: pi-agent-integration
description: Integrate `@mariozechner/pi-agent-core` as the agent abstraction inside another library or runtime. Use when implementing or refactoring Pi Agent wrappers, streaming bridges, `convertToLlm`/`transformContext`, queueing via `steer`/`followUp`, `continue()` semantics, or timeout/abort/session behavior.
---

Implement Pi-agent consumers with stable streaming, correct queue semantics, and minimal wrapper surface area.

## Step 1: Classify the request

Pick the path before editing:

| Request type | Read first |
| --- | --- |
| Wiring or updating agent wrapper APIs/options | `references/api-surface.md` |
| Adding behavior in a consumer library (chat, orchestration, tools) | `references/common-use-cases.md` |
| Debugging broken streaming/tool/continue behavior | `references/troubleshooting-workarounds.md` |

If the task spans multiple categories, load only the relevant files above.

## Step 2: Apply integration guardrails

1. Treat `Agent` as the execution engine and keep wrapper abstractions thin.
2. Stream user-visible text only from `message_update` + `assistantMessageEvent.type === "text_delta"`.
3. Bridge deltas into `AsyncIterable<string>` and pass that iterable to downstream streaming surfaces.
4. Preserve message boundaries when streaming multi-message assistant output (insert separators intentionally, then normalize).
5. Never call `prompt()` or `continue()` while the agent is running; use `steer()`/`followUp()` for mid-run input.
6. Keep `convertToLlm` and `transformContext` explicit, deterministic, and easy to test.
7. Keep tool calls/results as internal execution artifacts unless product UX explicitly requires otherwise.

## Step 3: Implement with minimal surface

1. Prefer constructor options over custom wrapper state machines (`streamFn`, `getApiKey`, `sessionId`, `thinkingBudgets`, `maxRetryDelayMs`).
2. Use `transformContext` for pruning/injection and `convertToLlm` for message-role conversion/filtering.
3. Keep queue mode explicit (`steeringMode`, `followUpMode`) when concurrency/order matters.
4. For server-proxied model access, use `streamFn` with `streamProxy`-style behavior instead of bespoke provider logic in consumers.
5. Keep failure behavior explicit: timeout/abort paths should set observable diagnostics and terminate streaming cleanly.

## Step 4: Verify behavior

1. Verify event-to-stream bridge emits only text deltas and always closes the iterable.
2. Verify `prompt()`/`continue()` race handling (throws while streaming; queue path works via `steer`/`followUp`).
3. Verify `continue()` preconditions: non-empty context and valid last-message role semantics.
4. Verify custom message types survive agent state while `convertToLlm` emits only LLM-compatible roles.
5. Verify tool execution and turn lifecycle events remain internal unless explicitly exposed.
6. Verify newline joining/normalization parity between streamed and finalized outputs.

## Step 5: Migration and version checks

1. Check for queue API migrations (`queueMessage` -> `steer`/`followUp`) before editing old wrappers.
2. Check renamed hooks/options (`messageTransformer` -> `convertToLlm`, `preprocessor` -> `transformContext`).
3. Check default/available options in current package version before adding compatibility shims.
4. Favor hard cutovers unless backward compatibility is explicitly requested.

