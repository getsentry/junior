# API Surface

Primary package: `@mariozechner/pi-agent-core`

## Core exports

- `Agent` class (`src/agent.ts`)
- `agentLoop`, `agentLoopContinue` (`src/agent-loop.ts`)
- `streamProxy` (`src/proxy.ts`)
- Types from `src/types.ts`: `AgentMessage`, `AgentTool`, `AgentEvent`, `AgentState`, `AgentLoopConfig`, `StreamFn`

## `Agent` constructor options

- `initialState` (`systemPrompt`, `model`, `thinkingLevel`, `tools`, `messages`)
- `convertToLlm(messages)` for message conversion/filtering
- `transformContext(messages, signal)` for pruning/injection before conversion
- `steeringMode`, `followUpMode` (`"one-at-a-time"` or `"all"`)
- `streamFn` for custom/proxied streaming
- `sessionId`, `getApiKey`, `thinkingBudgets`, `transport`, `maxRetryDelayMs`

## Core runtime methods

- Prompting: `prompt(string | AgentMessage | AgentMessage[])`, `continue()`
- Queueing: `steer(message)`, `followUp(message)`, plus clear/dequeue helpers
- State mutation: `setSystemPrompt`, `setModel`, `setThinkingLevel`, `setTools`, `replaceMessages`, `appendMessage`, `clearMessages`, `reset`
- Lifecycle: `abort()`, `waitForIdle()`, `subscribe(listener)`

## Event contract

- Lifecycle events: `agent_start`, `turn_start`, `turn_end`, `agent_end`
- Message events: `message_start`, `message_update`, `message_end`
- Tool events: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- Streaming text should be read from `message_update` where `assistantMessageEvent.type === "text_delta"`

## Message pipeline contract

`AgentMessage[]` -> `transformContext()` -> `convertToLlm()` -> LLM `Message[]`

- `transformContext`: keep message-level behavior (pruning, external context injection)
- `convertToLlm`: convert/filter to provider-compatible `user`/`assistant`/`toolResult` messages

## Continue/queue semantics

- `prompt()` and `continue()` throw if `isStreaming` is true.
- `continue()` requires message history and valid tail state.
- If tail is `assistant`, `continue()` can resume queued `steer`/`followUp`; otherwise it throws.
- Mid-run user input should be queued with `steer` or `followUp`, not re-entered with `prompt`.

## Version and migration points to check

- Queue API migration: `queueMessage` replaced by `steer`/`followUp`
- Option migration: `messageTransformer` -> `convertToLlm`, `preprocessor` -> `transformContext`
- Transport abstraction changes: prefer `streamFn` customization for proxy/server routing
