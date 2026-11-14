# API Surface

Open this when wiring or updating Pi `Agent`, low-level loop, provider, stream, or tool APIs.

Primary package: `@earendil-works/pi-agent-core`
Published baseline: npm `latest` `1.5.2`

## Package facts

| Area         | Current contract                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Runtime      | Node `>=22.19.0`                                                                                                        |
| Repository   | `github.com/earendil-works/pi`, package directory `packages/agent`                                                      |
| Imports      | Root package only                                                                                                       |
| Model layer  | `@earendil-works/pi-ai`; a bound `Models.streamSimple` satisfies `StreamFn`, which takes a `TranscriptContext`          |
| Main exports | `Agent`, the agent loops, `runToolCall`, `streamProxy`, `setDefaultStreamFn`, `DEFAULT_AGENT_IDENTITY`, and their types |

## `Agent` options

| Option                               | Use                                                                                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streamFn`                           | Required provider stream function. Return a stream and encode expected failures in its events and final result.                                                                                                                     |
| `initialState`                       | Seed `systemPrompt`, `model`, `thinkingLevel`, `tools`, and `messages`. `systemPrompt` and `tools` become the leading system message unless `messages` already starts with one.                                                     |
| `convertToLlm(messages)`             | Convert or filter `AgentMessage[]` to provider messages. Keep expected failures no-throw.                                                                                                                                           |
| `transformContext(messages, signal)` | Prune or inject context before conversion. Keep expected failures no-throw.                                                                                                                                                         |
| `getApiKey(provider)`                | Resolve credentials for each model call. Return `undefined` for an expected missing credential.                                                                                                                                     |
| `onPayload`, `onResponse`            | Observe or patch provider payloads and responses through `pi-ai` stream options.                                                                                                                                                    |
| `onProviderStreamEvent`              | Observe parsed provider stream events before normalization.                                                                                                                                                                         |
| `beforeToolCall`, `afterToolCall`    | Block, inspect, patch, or terminate tool results. Honor the `AbortSignal`.                                                                                                                                                          |
| `finishTurn`                         | Runs after the turn is finalized and before `turn_end`, also for error and aborted responses, which still end the run. Return `{ action: "end" }` to stop after `turn_end`, or `{ action: "continue" }` to ensure one more request. |
| `prepareRequest`                     | Update the request just before each provider call.                                                                                                                                                                                  |
| `prepareNextTurn`                    | Return a next-turn update. This compatibility-shaped `Agent` hook receives only the run signal. Runs after `turn_end` only when another turn starts.                                                                                |
| `prepareNextTurnWithContext`         | Return a next-turn context, messages, model, or thinking update with the completed-turn context and run signal. Runs only when another turn starts. Prefer this variant.                                                            |
| `steeringMode`, `followUpMode`       | Drain queues as `"one-at-a-time"` or `"all"`. Both default to one-at-a-time.                                                                                                                                                        |
| Other request options                | `sessionId`, `thinkingBudgets`, `transport`, `maxRetryDelayMs`, `toolExecution`, and `identity`.                                                                                                                                    |

`Agent` requires an options object and `streamFn` in the public type contract. At runtime a missing `streamFn` falls back to the function set with `setDefaultStreamFn()`, and throws if none is set. Use that fallback only in a host that owns a default model runtime. The public mutable stream property is `agent.streamFunction`.

## Runtime surface

- Prompt with `prompt(string, images?)`, `prompt(AgentMessage)`, or `prompt(AgentMessage[])`.
- Continue with `continue()`.
- Queue with `steer()`, `followUp()`, queue clear methods, `hasQueuedMessages()`, and `peekQueuedMessages()`.
- Control a run with `abort()`, `waitForIdle()`, `subscribe()`, and `signal`.
- Assign `agent.state.model`, `thinkingLevel`, `tools`, and `messages`. Assigning `tools` or `messages` copies the top-level array.
- `agent.state.systemPrompt` is read-only. It replays the transcript's system messages. To change the prompt, append a system message with `content` or `sections`.
- Before each request, Pi compares `agent.state.tools` with the tools that the transcript declares. If they differ, Pi announces the change to the model in a system message.
- Inspect `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage`.
- Call `reset()` only when idle. It cuts the transcript back to the leading system message and clears runtime state and both queues. It rejects during an active run.

## Events and message flow

- Lifecycle: `agent_start`, `turn_start`, `turn_end`, `agent_end`.
- Messages: `message_start`, `message_update`, `message_end`.
- Tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`. `tool_execution_end` carries `durationMs` when the tool ran.
- Forward visible text only from `message_update` plus `text_delta`.
- `Agent.subscribe()` awaits listeners in registration order. A run settles after awaited `agent_end` listeners finish.

Message flow is `AgentMessage[] -> transformContext() -> convertToLlm() -> pi-ai Message[]`.

System messages in the transcript carry the prompt and tool declarations. The default `convertToLlm` keeps `system`, `user`, `assistant`, and `toolResult` messages.

Keep custom messages in state when useful. Filter or map them in `convertToLlm`. For low-level continuation, conversion must leave a final `user` or `toolResult` message.

## Continue and queues

- `prompt()` and `continue()` reject while a run is active.
- `continue()` rejects when the history is empty or has only system messages.
- A `user` or `toolResult` tail starts normal continuation.
- An `assistant` tail drains steering first, then follow-ups. It rejects if both queues are empty.
- Steering runs after the current assistant turn and tool batch.
- Follow-ups run only after the agent would otherwise stop.

## Tools

- Default batch mode is `parallel`. Preflight is sequential. Allowed tools run concurrently.
- `tool_execution_end` follows completion order. Tool-result messages and `turn_end.toolResults` follow assistant source order.
- Global `toolExecution: "sequential"` or any per-tool `executionMode: "sequential"` makes the full batch sequential.
- Pi calls the tool's `prepareArguments`, then validates a copy of the arguments with `@earendil-works/pi-schema` and coerces values, for example `null` to `"null"` for a string.
- A `length` stop fails every tool call in that assistant message without running it.
- `beforeToolCall` runs after start emission and argument validation. A blocked result can include `reason` and `terminate`.
- `afterToolCall` can replace `content`, `details`, `structuredContent`, `isError`, `usage`, or `terminate`. These values are replacements, not deep merges. Replacing `content` without `structuredContent` drops `structuredContent`.
- `AgentToolResult` can include `structuredContent`, `usage`, `isError`, and `terminate`. `structuredContent` is not sent to the model.
- On failure, throw from `execute()` or return `isError: true`. Both reach the model as an error result. `isError: true` also keeps `details` and `structuredContent`. Late progress callbacks after settlement are ignored.
- Early termination happens only when every finalized result in the batch terminates.

## Low-level loops

- Start with `agentLoop(prompts, context, config, signal, streamFn)`.
- Continue with `agentLoopContinue(context, config, signal, streamFn)`.
- The `runAgentLoop` variants also require an event sink before `signal` and `streamFn`.
- Pass `undefined` in the signal position when no signal exists. The final `streamFn` argument is required.
- Low-level-only queue providers are `getSteeringMessages` and `getFollowUpMessages`.
- `finishTurn`, `prepareRequest`, and `prepareNextTurn` exist on both the low-level config and the `Agent` wrapper. Low-level `prepareNextTurn` receives the completed-turn context.
- `runToolCall(toolCall, options)` runs one tool call through validation, hooks, and execution outside the loop.
- Raw streams preserve event order but do not await consumer event handling between producer phases.

## Proxy streams

- `StreamFn` structurally matches `Models.streamSimple`.
- Encode expected failures with protocol events and a final assistant message whose `stopReason` is `"error"` or `"aborted"`.
- `streamProxy(model, context, options)` accepts `authToken`, `proxyUrl`, a local `signal`, and serializable stream options, including OpenAI-compatible `samplingParams` and `disableContinuation`. It returns an `AssistantMessageEventStream`.
