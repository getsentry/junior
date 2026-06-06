# AgentHarness

Open this when using Pi's built-in harness, sessions, skills, prompt templates, resources, environment, compaction, or tree navigation.

## When to use it

Use `AgentHarness` when the consumer needs more than a single `Agent` transcript:

- durable session tree and leaf navigation
- skills or prompt-template invocation
- app-owned resources included in system prompts
- active tool subsets
- filesystem and shell environment abstraction
- compaction or branch summary operations
- provider auth/header hooks
- high-level queued UX with `steer`, `followUp`, and `nextTurn`

Use bare `Agent` when the consumer already owns these concerns and only needs Pi execution/events/tools.

## Constructor inputs

| Option                         | Purpose                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `env`                          | `ExecutionEnv` filesystem/shell capability. Operations return `Result` values rather than throwing for expected failures. |
| `session`                      | Session tree storage for messages, settings, compactions, labels, and leaf state.                                         |
| `tools`                        | Available `AgentTool` definitions.                                                                                        |
| `resources`                    | App-owned skills and prompt templates.                                                                                    |
| `systemPrompt`                 | Static prompt or async function using env/session/model/thinking/tools/resources.                                         |
| `getApiKeyAndHeaders(model)`   | Per-request provider auth and headers.                                                                                    |
| `streamOptions`                | Curated provider options: transport, timeout, retries, headers, metadata, cache retention.                                |
| `model`, `thinkingLevel`       | Active model and reasoning level.                                                                                         |
| `activeToolNames`              | Optional initial active tool subset.                                                                                      |
| `steeringMode`, `followUpMode` | Queue draining policy.                                                                                                    |

## Main methods

- Run work: `prompt(text, { images })`, `skill(name, additionalInstructions)`, `promptFromTemplate(name, args)`.
- Queue work: `steer(text)`, `followUp(text)`, `nextTurn(text)`.
- Mutate session: `appendMessage(message)`, `compact(customInstructions)`, `navigateTree(targetId, options)`.
- Update runtime settings: `setModel`, `setThinkingLevel`, `setTools`, `setActiveTools`, `setResources`, `setStreamOptions`, `setSteeringMode`, `setFollowUpMode`.
- Inspect runtime settings: `getModel`, `getThinkingLevel`, `getTools`, `getActiveTools`, `getResources`, `getStreamOptions`, `getSteeringMode`, `getFollowUpMode`.
- Lifecycle: `abort()`, `waitForIdle()`, `subscribe(listener)`, `on(type, handler)`.

## Harness events and hooks

Harness subscribers receive both core `AgentEvent` values and harness-owned events.

Use `on(type, handler)` for hook-style events that can return patches:

- `before_agent_start`: replace initial messages or system prompt.
- `context`: replace context messages before provider conversion.
- `before_provider_request`: patch stream options.
- `before_provider_payload`: replace provider payload.
- `tool_call`: block tool execution with a reason.
- `tool_result`: patch content, details, error state, or termination.
- `session_before_compact`: cancel or provide compaction output.
- `session_before_tree`: cancel or provide branch summary/tree options.

Observe these events for state and diagnostics:

- `after_provider_response`
- `session_compact`
- `session_tree`
- `model_update`
- `thinking_level_update`
- `resources_update`
- `tools_update`
- `queue_update`
- `save_point`
- `abort`
- `settled`

## Queue guidance

- `steer()` targets the active run's next opportunity after the current assistant turn/tool batch.
- `followUp()` runs after the agent would otherwise stop.
- `nextTurn()` queues text for the next explicit turn and should be kept distinct from mid-run steering.
- `queue_update` exposes current queued `steer`, `followUp`, and `nextTurn` messages.

## Session and compaction guidance

- Keep app-specific data in session entries or resources when it should survive turns.
- Use `compact()` for harness-managed history reduction.
- Use `navigateTree()` when moving the active leaf or summarizing a branch.
- Treat compaction/tree hooks as policy boundaries; return structured results instead of mutating storage behind the harness.

## Verification

Verify:

1. Hook return patches are applied at the documented boundary.
2. Session writes flush before relying on persisted state.
3. Active tool names match the available tool set.
4. `abort()` clears queued steer/follow-up messages and emits `abort`.
5. `waitForIdle()` waits for the active run and awaited listeners.
6. Compaction and tree navigation preserve expected leaf/session state.
