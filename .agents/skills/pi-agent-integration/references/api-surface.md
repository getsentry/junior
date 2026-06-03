# API Surface

Open this when wiring or updating Pi `Agent`, low-level loop, provider, stream, or tool APIs.

Primary package: `@earendil-works/pi-agent-core`
Current source baseline: npm `latest` at last synthesis was `0.78.0`.

## Package facts

| Area         | Latest contract                                                       |
| ------------ | --------------------------------------------------------------------- |
| Package      | `@earendil-works/pi-agent-core`                                       |
| Runtime      | Node `>=22.19.0`                                                      |
| Repository   | `github.com/earendil-works/pi`, `packages/agent`                      |
| Main imports | `@earendil-works/pi-agent-core`, `@earendil-works/pi-agent-core/node` |
| Model layer  | Built on `@earendil-works/pi-ai`                                      |

## Top-level exports

- Core execution: `Agent`, `agentLoop`, `agentLoopContinue`, `runAgentLoop`, `runAgentLoopContinue`.
- Provider proxy: `streamProxy`, `ProxyAssistantMessageEvent`, `ProxyStreamOptions`.
- Core types: `AgentMessage`, `AgentTool`, `AgentToolResult`, `AgentEvent`, `AgentState`, `AgentContext`, `AgentLoopConfig`, `StreamFn`, `QueueMode`, `ToolExecutionMode`, `ThinkingLevel`.
- Harness layer: `AgentHarness`, session repositories, skill loading helpers, prompt-template helpers, compaction helpers, message helpers, and harness types.
- Node entry: `NodeExecutionEnv` from `@earendil-works/pi-agent-core/node`.

## `Agent` options

| Option                               | Use                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `initialState`                       | Seed `systemPrompt`, `model`, `thinkingLevel`, `tools`, and `messages`.                                                                  |
| `convertToLlm(messages)`             | Convert/filter `AgentMessage[]` to provider-compatible LLM messages. Must not throw/reject for expected cases.                           |
| `transformContext(messages, signal)` | Prune or inject context before conversion. Must not throw/reject for expected cases.                                                     |
| `streamFn`                           | Replace provider streaming, usually for proxying or tracing. Must return a stream and encode expected failures in stream events/results. |
| `getApiKey(provider)`                | Resolve short-lived provider credentials per LLM call. Return `undefined` rather than throwing for missing expected auth.                |
| `onPayload`, `onResponse`            | Observe or patch provider payload/response through `pi-ai` stream options.                                                               |
| `beforeToolCall`, `afterToolCall`    | Block, inspect, patch, or terminate tool results at Pi's tool boundary. Honor `AbortSignal`.                                             |
| `prepareNextTurn`                    | Replace context/model/thinking state before another provider request in the current run.                                                 |
| `steeringMode`, `followUpMode`       | Drain queued messages as `"one-at-a-time"` or `"all"`. Defaults are one-at-a-time.                                                       |
| `sessionId`                          | Forward provider cache/session identity.                                                                                                 |
| `thinkingBudgets`                    | Override per-thinking-level token budgets.                                                                                               |
| `transport`                          | Select preferred provider transport.                                                                                                     |
| `maxRetryDelayMs`                    | Bound provider-requested retry delays.                                                                                                   |
| `toolExecution`                      | Execute tool batches as `"parallel"` by default or `"sequential"`.                                                                       |

## `Agent` runtime surface

- Prompting: `prompt(string, images?)`, `prompt(AgentMessage)`, `prompt(AgentMessage[])`.
- Continuation: `continue()`.
- Queueing: `steer(message)`, `followUp(message)`, `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`, `hasQueuedMessages()`.
- Lifecycle: `abort()`, `waitForIdle()`, `subscribe(listener)`, `signal`.
- State: mutate `agent.state.systemPrompt`, `agent.state.model`, `agent.state.thinkingLevel`, `agent.state.tools`, and `agent.state.messages`; use `reset()` to clear transcript/runtime/queues.
- Runtime state: `agent.state.isStreaming`, `agent.state.streamingMessage`, `agent.state.pendingToolCalls`, `agent.state.errorMessage`.

## Events and streaming

- Lifecycle events: `agent_start`, `turn_start`, `turn_end`, `agent_end`.
- Message events: `message_start`, `message_update`, `message_end`.
- Tool events: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
- `message_update` is assistant-only but includes text, thinking, and tool-call deltas. Forward user-visible text only when `assistantMessageEvent.type === "text_delta"`.
- `Agent.subscribe()` awaits listener promises in registration order. `agent_end` is the final event, but `prompt()`, `continue()`, and `waitForIdle()` settle only after awaited `agent_end` listeners finish.

## Message pipeline

`AgentMessage[]` -> `transformContext()` -> `AgentMessage[]` -> `convertToLlm()` -> LLM `Message[]`.

- Keep app-specific/custom messages in agent state when useful.
- Filter or map custom messages in `convertToLlm`.
- For low-level continuation, the last message must convert to `user` or `toolResult`; Pi can only check raw assistant tails before conversion.

## Continue and queue semantics

- `prompt()` throws while a run is active.
- `continue()` throws while a run is active.
- `continue()` throws on empty history.
- `continue()` normally resumes from a `user` or `toolResult` tail.
- If the tail is `assistant`, `continue()` drains queued steering first, then queued follow-ups; if neither exists, it throws.
- `steer()` injects queued messages after the current assistant turn and tool batch finish.
- `followUp()` runs only after the agent would otherwise stop.

## Tool execution

- Default batch mode is `parallel`: tool preflight is sequential, allowed tools execute concurrently, `tool_execution_end` follows completion order, and tool-result messages/`turn_end.toolResults` follow assistant source order.
- Global `toolExecution: "sequential"` executes one call at a time.
- A per-tool `executionMode: "sequential"` forces the whole batch sequential.
- `beforeToolCall` runs after tool-start emission and argument validation; returning `{ block: true }` produces an error tool result.
- `afterToolCall` can replace `content`, `details`, `isError`, or `terminate`; `content` and `details` are full replacements, not deep merges.
- Tool `execute()` should throw on failure rather than returning failure text as successful content.
- `terminate: true` skips the automatic follow-up LLM call only when every finalized result in the batch terminates.

## Low-level loop API

- Use `agentLoop(prompts, context, config, signal?, streamFn?)` to start with prompt messages.
- Use `agentLoopContinue(context, config, signal?, streamFn?)` to continue existing context.
- Raw loop streams preserve event order but do not wait for async event handling to settle before producer phases continue.
- Use `Agent` instead when event processing must be a barrier before tool preflight or run settlement.
- `AgentLoopConfig` adds low-level-only hooks such as `shouldStopAfterTurn`, `getSteeringMessages`, and `getFollowUpMessages`.

## Proxy and stream functions

- `streamFn` has the same shape as `pi-ai` `streamSimple`.
- Expected provider/request/runtime failures must be encoded in the returned stream with protocol events and a final assistant message with `stopReason: "error"` or `"aborted"`.
- `streamProxy(model, context, options)` proxies through a server with `authToken`, `proxyUrl`, local `signal`, and serializable stream options.
