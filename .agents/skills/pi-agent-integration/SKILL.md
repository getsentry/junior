---
name: pi-agent-integration
description: Integrate the latest `@earendil-works/pi-agent-core` APIs into an app, library, runtime, or agent harness. Use for Pi `Agent`, `AgentHarness`, streaming bridges, tool execution hooks, `convertToLlm`/`transformContext`, queueing via `steer`/`followUp`, `continue()` semantics, `streamFn`/`streamProxy`, timeout/abort, session, skill, or compaction behavior.
---

Implement Pi-agent consumers against the latest published Pi API with stable streaming, correct queue semantics, and minimal wrapper surface area.

## Step 1: Classify the request

Pick the path before editing:

| Request type                                                                      | Read first                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------- |
| Wiring or updating `Agent`, loop, provider, stream, or tool APIs                  | `references/api-surface.md`                 |
| Adding Pi behavior in a consuming app, library, or runtime                        | `references/common-use-cases.md`            |
| Using Pi's built-in harness, sessions, skills, resources, or compaction           | `references/harness.md`                     |
| Debugging broken streaming, tools, queues, continuation, proxy, or abort behavior | `references/troubleshooting-workarounds.md` |

If a task spans multiple categories, load only the relevant references above. Keep guidance Pi-specific unless the user explicitly asks about a consuming product.

## Step 2: Apply integration guardrails

1. Treat npm `latest` for `@earendil-works/pi-agent-core` as the source of truth before relying on a contract.
2. Use `Agent` when event handling must be awaited as part of run settlement; use low-level `agentLoop` only when an observational event stream is enough.
3. Stream user-visible text only from `message_update` where `assistantMessageEvent.type === "text_delta"`.
4. Preserve assistant message boundaries deliberately when forwarding multi-message output.
5. Do not call `prompt()` or `continue()` while an agent is active; queue mid-run input with `steer()` or `followUp()`.
6. Treat normal `continue()` as a resume from a non-empty `user` or `toolResult` tail. An `assistant` tail can only drain queued steering/follow-up messages, otherwise it throws.
7. Keep `streamFn`, `convertToLlm`, `transformContext`, `getApiKey`, queue providers, and loop hooks no-throw for expected request/runtime failures; return safe values or encode failures in protocol events.
8. Keep tool calls, tool progress, tool results, thinking deltas, and provider payloads internal unless the product UX explicitly exposes them.
9. Prefer Pi's built-in harness when sessions, skills, prompt templates, resources, filesystem/shell environment, compaction, or tree navigation are required.

## Step 3: Implement with minimal surface

1. Prefer Pi options over custom wrapper state machines: `streamFn`, `getApiKey`, `sessionId`, `thinkingBudgets`, `transport`, `maxRetryDelayMs`, `onPayload`, `onResponse`, `beforeToolCall`, `afterToolCall`, `prepareNextTurn`, `toolExecution`, `steeringMode`, and `followUpMode`.
2. Mutate `Agent` state through `agent.state` properties and `reset()`; do not invent setter wrappers unless the consumer API needs them.
3. Use `transformContext` for message-level pruning/injection and `convertToLlm` for provider-compatible role conversion/filtering.
4. Keep queue modes explicit (`"one-at-a-time"` or `"all"`) when ordering or batching matters.
5. For server-proxied model access, use `streamFn` with `streamProxy`-style behavior instead of provider logic scattered through consumers.
6. For tool policy, use `toolExecution`, per-tool `executionMode`, `beforeToolCall`, `afterToolCall`, thrown tool errors, and `terminate` before adding a custom tool runner.
7. Keep timeout/abort paths observable and make sure streams/iterables settle cleanly.

## Step 4: Verify behavior

1. Verify the event-to-stream bridge emits only text deltas, preserves intended boundaries, and closes on success, error, and abort.
2. Verify `prompt()`/`continue()` race handling and queued `steer()`/`followUp()` behavior.
3. Verify `continue()` preconditions for empty history, `user` tail, `toolResult` tail, and `assistant` tail with and without queued messages.
4. Verify custom message types remain in agent state while `convertToLlm` emits only provider-compatible messages.
5. Verify `streamFn` encodes expected provider failures instead of throwing/rejecting.
6. Verify tool execution ordering under default parallel mode, sequential overrides, hook blocking/patching, progress updates, and `terminate` behavior.
7. Verify `Agent.subscribe()` listener settlement and `waitForIdle()` behavior when listeners perform async work.
8. Verify `AgentHarness` session, resource, hook, compaction, and abort behavior when the harness path is used.

## Step 5: Version discipline

1. Target the latest published Pi package only.
2. Re-check the latest package metadata and declarations before material API updates.
3. Do not add backward-compatibility shims or old package-name guidance unless the user explicitly asks for a migration.
