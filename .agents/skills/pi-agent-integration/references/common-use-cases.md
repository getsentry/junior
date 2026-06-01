# Common Use Cases

Open this when adding Pi behavior in a consuming app, library, runtime, or adapter.

## Stream assistant text into another surface

Use `agent.subscribe()` and forward only:

```ts
event.type === "message_update" &&
  event.assistantMessageEvent.type === "text_delta";
```

Bridge those deltas into the consumer's streaming abstraction. Insert separators only at intentional assistant message boundaries and apply the same normalization to streamed and finalized output.

## Proxy provider access

Use `streamFn` when model calls must route through a backend, tracing layer, gateway, or policy boundary.

- Preserve the `StreamFn` contract: return a stream; do not throw/reject for expected provider failures.
- Use `streamProxy` when a browser or untrusted client needs server-owned auth.
- Use `onPayload` and `onResponse` when the consumer needs provider payload/response observation without replacing the stream function.

## Resolve short-lived credentials

Use `getApiKey(provider)` for per-call provider credentials. Return `undefined` for expected unauthenticated states and let the consumer own visible auth recovery.

## Add custom app messages

Extend `CustomAgentMessages` and keep custom entries in `agent.state.messages` when they matter to UI/session state. Use `convertToLlm` to filter UI-only messages or map custom messages to provider-compatible `user`, `assistant`, or `toolResult` messages.

## Prune or augment context

Use `transformContext(messages, signal)` for message-level pruning, compaction insertion, external context injection, and other operations that should happen before provider conversion.

Keep `transformContext` deterministic and no-throw for expected cases. Return the original messages or a conservative safe subset when pruning cannot run.

## Support steering and follow-ups

Use `steer()` for user input that should influence the next model call after the current assistant turn and tool batch finish. Use `followUp()` for input that should wait until the agent would otherwise stop.

Set `steeringMode` and `followUpMode` explicitly when queued-message batching affects UX or correctness.

## Retry or resume generation

Use `continue()` only when the agent is idle and has a valid transcript.

- `user` or `toolResult` tail: normal continuation.
- `assistant` tail with queued steering/follow-up: drains queued messages as a new prompt path.
- `assistant` tail without queued messages: throws.

For provider retry, trim only retryable trailing assistant error messages and continue from a safe `user` or `toolResult` boundary.

## Bound and abort runs

Race the prompt/continue promise against the consumer timeout. On timeout, call `agent.abort()`, wait for run settlement when possible, and close downstream streams/iterables in `finally`.

## Execute tools through Pi

Prefer Pi's tool execution surface over a custom runner.

- Use `toolExecution` for global parallel/sequential policy.
- Use per-tool `executionMode` for tools that cannot run in a concurrent batch.
- Use `beforeToolCall` to block or authorize a call after validation.
- Use `afterToolCall` to patch content/details/error/termination at the final tool boundary.
- Throw from `execute()` on tool failure; Pi will create an error tool result for the model.
- Use `onUpdate` for progress, not user-visible final replies.

## Stop gracefully between turns

Use low-level `shouldStopAfterTurn` when the consumer owns the loop and needs to stop after a completed assistant turn before queues are polled.

Use `prepareNextTurn` when the next provider request needs a replacement context, model, or thinking level.

## Choose `AgentHarness`

Use Pi's `AgentHarness` instead of a custom wrapper when the consumer needs a session tree, skill loading/invocation, prompt templates, resources, filesystem/shell environment, compaction, branch navigation, provider request hooks, or high-level queue UX. Read `references/harness.md`.
