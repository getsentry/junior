# API Surface

Open this when wiring or updating Pi `Agent`, low-level loop, provider, stream, or tool APIs.

Primary package: `@earendil-works/pi-agent-core`
Published baseline: npm `latest` `0.84.1`

## Package facts

| Area         | Current contract                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Runtime      | Node `>=22.19.0`                                                                                                 |
| Repository   | `github.com/earendil-works/pi`, package directory `packages/agent`                                               |
| Imports      | Root package, `/node` for `NodeExecutionEnv`, and `/session/testing` for session backend conformance tests       |
| Model layer  | `@earendil-works/pi-ai`; a bound `Models.streamSimple` satisfies `StreamFn`                                      |
| Main exports | Core agent and loops, proxy helpers, harness and session APIs, compaction helpers, search helpers, and telemetry |

## `Agent` options

| Option                               | Use                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `streamFn`                           | Required provider stream function. Return a stream and encode expected failures in its events and final result.            |
| `initialState`                       | Seed `systemPrompt`, `model`, `thinkingLevel`, `tools`, and `messages`.                                                    |
| `convertToLlm(messages)`             | Convert or filter `AgentMessage[]` to provider messages. Keep expected failures no-throw.                                  |
| `transformContext(messages, signal)` | Prune or inject context before conversion. Keep expected failures no-throw.                                                |
| `getApiKey(provider)`                | Resolve credentials for each model call. Return `undefined` for an expected missing credential.                            |
| `onPayload`, `onResponse`            | Observe or patch provider payloads and responses through `pi-ai` stream options.                                           |
| `beforeToolCall`, `afterToolCall`    | Block, inspect, patch, or terminate tool results. Honor the `AbortSignal`.                                                 |
| `shouldStopAfterTurn`                | Stop after a complete turn and before queues or another model call. Receives turn context and the run signal.              |
| `prepareNextTurn`                    | Return a next-turn update. This compatibility-shaped `Agent` hook receives only the run signal.                            |
| `prepareNextTurnWithContext`         | Return a next-turn context, model, or thinking update with the completed-turn context and run signal. Prefer this variant. |
| `steeringMode`, `followUpMode`       | Drain queues as `"one-at-a-time"` or `"all"`. Both default to one-at-a-time.                                               |
| Other request options                | `sessionId`, `thinkingBudgets`, `transport`, `maxRetryDelayMs`, and `toolExecution`.                                       |

`Agent` requires an options object and `streamFn` in the public type contract. The runtime fallback for older compiled consumers is not a latest-API integration path. The public mutable stream property is `agent.streamFunction`.

## Runtime surface

- Prompt with `prompt(string, images?)`, `prompt(AgentMessage)`, or `prompt(AgentMessage[])`.
- Continue with `continue()`.
- Queue with `steer()`, `followUp()`, queue clear methods, and `hasQueuedMessages()`.
- Control a run with `abort()`, `waitForIdle()`, `subscribe()`, and `signal`.
- Mutate `agent.state.systemPrompt`, `model`, `thinkingLevel`, `tools`, and `messages`.
- Inspect `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage`.
- Call `reset()` only when idle. It clears messages, runtime state, and both queues. It rejects during an active run.

## Events and message flow

- Lifecycle: `agent_start`, `turn_start`, `turn_end`, `agent_end`.
- Messages: `message_start`, `message_update`, `message_end`.
- Tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
- Forward visible text only from `message_update` plus `text_delta`.
- `Agent.subscribe()` awaits listeners in registration order. A run settles after awaited `agent_end` listeners finish.

Message flow is `AgentMessage[] -> transformContext() -> convertToLlm() -> pi-ai Message[]`.

Keep custom messages in state when useful. Filter or map them in `convertToLlm`. For low-level continuation, conversion must leave a final `user` or `toolResult` message.

## Continue and queues

- `prompt()` and `continue()` reject while a run is active.
- `continue()` rejects on empty history.
- A `user` or `toolResult` tail starts normal continuation.
- An `assistant` tail drains steering first, then follow-ups. It rejects if both queues are empty.
- Steering runs after the current assistant turn and tool batch.
- Follow-ups run only after the agent would otherwise stop.

## Tools

- Default batch mode is `parallel`. Preflight is sequential. Allowed tools run concurrently.
- `tool_execution_end` follows completion order. Tool-result messages and `turn_end.toolResults` follow assistant source order.
- Global `toolExecution: "sequential"` or any per-tool `executionMode: "sequential"` makes the full batch sequential.
- `beforeToolCall` runs after start emission and argument validation. A blocked result can include `reason` and `terminate`.
- `afterToolCall` can replace `content`, `details`, `isError`, `usage`, or `terminate`. These values are replacements, not deep merges.
- `AgentToolResult` can include `usage`, `addedToolNames`, and `terminate`.
- Throw from `execute()` on failure. Late progress callbacks after settlement are ignored.
- Early termination happens only when every finalized result in the batch terminates.

## Low-level loops

- Start with `agentLoop(prompts, context, config, signal, streamFn)`.
- Continue with `agentLoopContinue(context, config, signal, streamFn)`.
- The `runAgentLoop` variants also require an event sink before `signal` and `streamFn`.
- Pass `undefined` in the signal position when no signal exists. The final `streamFn` argument is required.
- Low-level-only queue providers are `getSteeringMessages` and `getFollowUpMessages`.
- `shouldStopAfterTurn` and `prepareNextTurn` exist on both the low-level config and the `Agent` wrapper.
- Raw streams preserve event order but do not await consumer event handling between producer phases.

## Proxy streams

- `StreamFn` structurally matches `Models.streamSimple`.
- Encode expected failures with protocol events and a final assistant message whose `stopReason` is `"error"` or `"aborted"`.
- `streamProxy(model, context, options)` accepts `authToken`, `proxyUrl`, a local `signal`, and serializable stream options, including OpenAI-compatible `samplingParams`.
- Check `references/troubleshooting-workarounds.md` for the published `0.84.1` finalized tool-call metadata defect.
