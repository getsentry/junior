# Common Use Cases

Open this when adding Pi behavior in an app, library, runtime, or adapter.

## Construct an agent

Pass a `streamFn` explicitly. A bound `Models.streamSimple` is the default direct-provider choice.

Keep model, tools, prompt, thinking level, and transcript in `initialState`. Keep request policy in `AgentOptions` or the matching public runtime properties.

## Stream assistant text

Use `agent.subscribe()` and forward only:

```ts
event.type === "message_update" &&
  event.assistantMessageEvent.type === "text_delta";
```

Insert separators only at intended assistant message boundaries. Apply the same normalization to streamed and final output.

## Proxy provider access

Use `streamFn` when model calls must pass through a backend, trace layer, gateway, or policy boundary.

- Preserve the `StreamFn` contract. Return a stream and encode expected provider failures.
- Use `streamProxy` when an untrusted client needs server-owned auth.
- Use `onPayload` and `onResponse` for observation or patching without replacing the stream function.
- Do not rely on finalized tool-call metadata through published `0.84.1` `streamProxy`; read the troubleshooting reference.

## Resolve short-lived credentials

Use `getApiKey(provider)` for each provider call. Return `undefined` for an expected unauthenticated state. Let the consumer own visible auth recovery.

## Keep custom messages

Extend `CustomAgentMessages` and retain useful custom entries in `agent.state.messages`. Use `convertToLlm` to filter UI-only messages or map custom messages to `user`, `assistant`, or `toolResult`.

## Prune or augment context

Use `transformContext(messages, signal)` for pruning, compaction insertion, or external context injection before conversion.

Return the original messages or a safe subset when an expected transform cannot run. Do not throw for expected cases.

## Support steering and follow-ups

Use `steer()` for input that should affect the next model call after the current assistant turn and tool batch. Use `followUp()` for input that should wait until the run would otherwise stop.

Set `steeringMode` and `followUpMode` when batching affects behavior.

## Retry or resume generation

Call `continue()` only when the agent is idle and has a valid transcript.

- A `user` or `toolResult` tail starts normal continuation.
- An `assistant` tail with queued steering or follow-up input drains the queue.
- An `assistant` tail without queued input rejects.

For provider retry, remove only retryable trailing assistant error messages. Continue from a safe `user` or `toolResult` boundary.

## Bound, abort, and reset runs

Race the prompt or continuation promise against the consumer timeout. On timeout, call `agent.abort()`, await settlement when possible, and close downstream streams in `finally`.

Call `reset()` only after `waitForIdle()`. It rejects while a run is active.

## Execute tools through Pi

- Use `toolExecution` and per-tool `executionMode` for ordering.
- Use `beforeToolCall` to block a validated call. Set `terminate` on a blocked result when it should join batch termination.
- Use `afterToolCall` to replace content, details, error state, usage, or termination.
- Throw from `execute()` on failure.
- Use `onUpdate` for progress. Late updates after settlement are ignored.
- Use `addedToolNames` when a result introduces tools from that transcript point onward.

## Stop or prepare the next turn

Use `shouldStopAfterTurn` on `Agent` or `AgentLoopConfig` to stop after a complete turn and before queues are polled.

Use `Agent.prepareNextTurnWithContext` when the next provider request needs a replacement context, model, or thinking level. Use low-level `prepareNextTurn` for the same turn-context contract in `AgentLoopConfig`.

## Add durable sessions

Use `Session` and a `SessionRepo` directly when the app needs a durable tree but can keep orchestration in bare `Agent`. Use `InMemorySessionRepo`, `JsonlSessionRepo`, or a backend that passes the `/session/testing` conformance suite.

Do not use published `0.84.1` `AgentHarness` operation methods as a production orchestration layer. They are scaffold paths and most reject with `HarnessNotImplemented`.
