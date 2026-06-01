# Troubleshooting and Workarounds

Open this when Pi-agent integration behavior is wrong in a consumer.

| Symptom                                                            | Likely cause                                                                        | Fix                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `prompt()` throws "Agent is already processing a prompt..."        | A run is active                                                                     | Queue input with `steer()`/`followUp()` or await `waitForIdle()`                         |
| `continue()` throws "Agent is already processing..."               | Continuation called during an active run                                            | Await the current prompt/continue or queue input                                         |
| `continue()` throws "No messages to continue from"                 | Empty transcript                                                                    | Restore or append prior `AgentMessage[]` first                                           |
| `continue()` throws "Cannot continue from message role: assistant" | Assistant tail with no queued steering/follow-up                                    | Trim to a safe `user`/`toolResult` boundary, queue a message, or start a new prompt      |
| Low-level continuation reaches a provider role error               | Last custom message converts to `assistant` or an invalid provider role             | Ensure `convertToLlm` leaves a final `user` or `toolResult` message                      |
| Stream shows no user-visible text                                  | Listener is forwarding the wrong event/delta                                        | Forward only `message_update` + `assistantMessageEvent.type === "text_delta"`            |
| Thinking or tool-call text leaks to users                          | Consumer renders all assistant deltas                                               | Ignore `thinking_*` and `toolcall_*` deltas unless a deliberate UX exposes them          |
| Streamed and final text differ                                     | Missing or inconsistent assistant-message boundaries                                | Insert separators intentionally and normalize streamed/final output the same way         |
| Run settles late after `agent_end`                                 | Async subscribers are still running                                                 | Treat `agent_end` as final event emission, not full idle; await `waitForIdle()`          |
| Tool preflight sees stale state with low-level loop                | Raw `agentLoop` event handling is observational                                     | Use `Agent` when message event handling must be a barrier before tool preflight          |
| Provider failures bypass normal event flow                         | `streamFn` throws/rejects for expected failures                                     | Return a stream that encodes `error`/`aborted` and a final assistant message             |
| Transform/conversion breaks lifecycle                              | `transformContext` or `convertToLlm` throws/rejects                                 | Return original messages, filtered messages, or another safe fallback for expected cases |
| Missing auth crashes the loop                                      | `getApiKey` throws for expected unauthenticated state                               | Return `undefined` and let the consumer own visible auth recovery                        |
| Tool results appear out of expected order                          | Default tool mode is parallel                                                       | Account for completion-order `tool_execution_end`; use `sequential` when required        |
| A sequential-only tool still changes whole batch behavior          | Per-tool `executionMode: "sequential"` forces the whole batch sequential            | Isolate the tool call or accept sequential batch execution                               |
| Tool failure is treated as success                                 | Tool returned failure text as normal content                                        | Throw from `execute()` so Pi emits an error tool result                                  |
| `terminate: true` does not stop the next LLM call                  | Mixed batch where not every finalized tool result terminates                        | Ensure every result in the batch sets `terminate: true`, or split the batch              |
| Queue order surprises                                              | Default queue mode drains one message at a time                                     | Set `steeringMode`/`followUpMode` explicitly                                             |
| Proxy errors are opaque                                            | Proxy response/event handling hides status/body                                     | Validate proxy status/body in the proxy server and encode visible stream errors          |
| Harness hook changes are ignored                                   | Handler is attached to the wrong event type or uses `subscribe()` instead of `on()` | Use `harness.on(type, handler)` for patch-returning hooks                                |
| Harness session state is missing                                   | Work relies on pending writes before they flush                                     | Wait for the harness method/idle boundary before reading persisted session state         |

## Debugging checklist

1. Confirm the package name is `@earendil-works/pi-agent-core` and the API was checked against npm `latest`.
2. Identify whether the consumer uses `Agent`, low-level loop APIs, or `AgentHarness`.
3. Check active-run state before any `prompt()` or `continue()` call.
4. Inspect the transcript tail before continuation.
5. Check whether queued steering/follow-up messages exist when continuing from an assistant tail.
6. Confirm stream forwarding filters to text deltas only.
7. Confirm expected provider failures are encoded in the stream rather than thrown.
8. Confirm transform/conversion/auth hooks return safe values for expected failures.
9. Confirm tool execution mode and per-tool execution overrides.
10. Confirm async listeners or harness hooks are not delaying settlement unexpectedly.
