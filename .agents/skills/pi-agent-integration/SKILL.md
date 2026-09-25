---
name: pi-agent-integration
description: Guides implementation and review of the latest `@earendil-works/pi-agent-core` API. Use when a task mentions Pi `Agent`, agent loops, streaming, tools, queues, continuation, proxying, aborts, sessions, skills, compaction, or the current `AgentHarness` scaffold.
---

Implement Pi consumers against the latest published API. Keep streaming stable, queue behavior explicit, and wrapper code small.

## Step 1: Classify the request

| Request type                                                                      | Read first                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------- |
| Wire or update `Agent`, loop, provider, stream, or tool APIs                      | `references/api-surface.md`                 |
| Add Pi behavior in an app, library, runtime, or adapter                           | `references/common-use-cases.md`            |
| Use `AgentHarness`, sessions, skills, resources, compaction, or execution helpers | `references/harness.md`                     |
| Debug streaming, tools, queues, continuation, proxy, abort, or harness failures   | `references/troubleshooting-workarounds.md` |

Load each reference that the task needs. Keep guidance Pi-specific unless the user asks about a consuming product.

## Step 2: Apply integration guardrails

1. Check npm `latest` for `@earendil-works/pi-agent-core` before relying on a contract. Treat the published package as authoritative. Treat upstream `main` as unreleased evidence.
2. Pass a `streamFn` when constructing `Agent`. Also pass it as the last argument to low-level loop functions.
3. Use `Agent` when event handling must finish before run settlement. Use `agentLoop` only when an observational event stream is enough.
4. Stream user-visible text only from `message_update` when `assistantMessageEvent.type === "text_delta"`.
5. Preserve assistant message boundaries when forwarding multi-message output.
6. Do not call `prompt()`, `continue()`, or `reset()` while an agent is active. Queue mid-run input with `steer()` or `followUp()`.
7. Continue a normal run only from a non-empty `user` or `toolResult` tail. An `assistant` tail can only drain queued steering or follow-up messages.
8. Keep `streamFn`, `convertToLlm`, `transformContext`, `getApiKey`, queue providers, and loop hooks no-throw for expected failures. Return safe values or encode the failure in stream events.
9. Keep tool calls, progress, results, thinking deltas, and provider payloads internal unless the product exposes them on purpose.
10. In `0.84.1`, do not recommend `AgentHarness` run, queue, hook, or navigation paths for production use. They are scaffold APIs and most reject with `HarnessNotImplemented`. Use bare `Agent`, session APIs, and standalone helpers until the published implementation is complete.

## Step 3: Implement with minimal surface

1. Prefer Pi options over wrapper state machines: `streamFn`, `getApiKey`, `sessionId`, `thinkingBudgets`, `transport`, `maxRetryDelayMs`, `onPayload`, `onResponse`, `beforeToolCall`, `afterToolCall`, `shouldStopAfterTurn`, `prepareNextTurnWithContext`, `toolExecution`, `steeringMode`, and `followUpMode`.
2. Mutate `Agent` through `agent.state` and public runtime options. Call `reset()` only when idle.
3. Use `transformContext` for message-level pruning or injection. Use `convertToLlm` for provider-compatible role conversion and filtering.
4. Set queue modes to `"one-at-a-time"` or `"all"` when ordering or batching matters.
5. Use `streamFn` with `streamProxy`-style behavior for server-proxied model access.
6. Use `toolExecution`, per-tool `executionMode`, `beforeToolCall`, `afterToolCall`, thrown tool errors, and `terminate` before adding a custom tool runner.
7. Keep timeout and abort paths observable. Make sure streams and iterables settle.

## Step 4: Verify behavior

1. Verify the event bridge emits only text deltas, preserves intended boundaries, and closes on success, error, and abort.
2. Verify active-run handling for `prompt()`, `continue()`, and `reset()`. Verify queued `steer()` and `followUp()` behavior.
3. Verify `continue()` with empty history and with `user`, `toolResult`, and `assistant` tails.
4. Verify custom messages remain in agent state while `convertToLlm` emits only provider-compatible messages.
5. Verify `streamFn` encodes expected provider failures instead of throwing or rejecting.
6. Verify parallel and sequential tool ordering, hook blocking and patches, progress updates, usage, added tools, and termination.
7. Verify `Agent.subscribe()` listener settlement and `waitForIdle()` with async listeners.
8. When reviewing the `AgentHarness` scaffold, verify implemented status in the published source before recommending any method.

## Step 5: Keep version discipline

1. Target npm `latest` only.
2. Re-check package metadata, declarations, implementation, README, and changelog before a material API update.
3. Do not present unreleased `main` behavior as published behavior.
4. Do not add compatibility shims or old package guidance unless the user asks for a migration.
