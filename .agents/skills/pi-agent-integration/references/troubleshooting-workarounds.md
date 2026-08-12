# Troubleshooting and Workarounds

Open this when Pi integration behavior is wrong.

| Symptom                                                    | Cause                                                                                | Fix                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `Agent` construction or loop call fails type checking      | `streamFn` or its required argument position is missing                              | Pass `streamFn`; pass `undefined` in the low-level signal position when needed                    |
| `prompt()` says the agent is already processing            | A run is active                                                                      | Queue with `steer()` or `followUp()`, or await `waitForIdle()`                                    |
| `continue()` says the agent is already processing          | Continuation started during a run                                                    | Await the run or queue input                                                                      |
| `reset()` says the agent is already processing             | Reset started during a run                                                           | Abort if needed, await `waitForIdle()`, then reset                                                |
| `continue()` says there are no messages                    | The transcript is empty                                                              | Restore or append prior messages                                                                  |
| `continue()` rejects an `assistant` tail                   | Both input queues are empty                                                          | Queue a message, trim to a safe `user` or `toolResult` boundary, or start a new prompt            |
| Low-level continuation reaches a provider role error       | Conversion leaves an invalid final role                                              | Make `convertToLlm` leave a final `user` or `toolResult`                                          |
| Visible text is missing or thinking/tool text leaks        | The listener forwards the wrong assistant delta                                      | Forward only `message_update` plus `text_delta`                                                   |
| Streamed and final text differ                             | Message boundaries or normalization differ                                           | Insert boundaries on purpose and use one normalization rule                                       |
| Run settlement is late after `agent_end`                   | Async subscribers are still running                                                  | Await the prompt or `waitForIdle()`                                                               |
| Tool preflight sees stale state with a low-level loop      | Raw loop event handling is observational                                             | Use `Agent` when event handling must be a barrier                                                 |
| Provider failures bypass normal events                     | `streamFn` throws or rejects for an expected failure                                 | Return a stream that encodes `error` or `aborted`                                                 |
| Transform, conversion, auth, or loop hooks break lifecycle | An expected failure escapes                                                          | Return original or filtered messages, `undefined`, or another safe value                          |
| Tool results appear in an unexpected order                 | Default tool mode is parallel                                                        | Expect completion-order end events or use sequential mode                                         |
| One sequential tool serializes every call                  | Any per-tool sequential override affects the full batch                              | Isolate the call or accept sequential batch execution                                             |
| Tool failure appears successful                            | The tool returned failure text as normal content                                     | Throw from `execute()`                                                                            |
| A blocked tool does not terminate                          | The block result omitted `terminate`, or another batch result did not terminate      | Set `terminate` on every finalized result that must join early termination                        |
| `afterToolCall` loses nested fields                        | `content`, `details`, and `usage` are full replacements                              | Return the complete replacement value                                                             |
| Progress arrives after tool completion                     | The tool calls `onUpdate` after its promise settles                                  | Stop updates before settlement; Pi ignores late callbacks                                         |
| Added tools are not available from the result point        | `addedToolNames` is missing from `AgentToolResult`                                   | Return the introduced tool names and keep the definitions available                               |
| `prepareNextTurn` lacks completed-turn context             | The signal-only `Agent` compatibility hook is in use                                 | Use `Agent.prepareNextTurnWithContext`                                                            |
| `AgentHarness` method rejects with `HarnessNotImplemented` | Published `0.84.1` ships a compile-complete scaffold with unfinished operation paths | Use bare `Agent`, direct session APIs, or standalone helpers                                      |
| Old harness names do not compile                           | `0.84.0` replaced the legacy harness and session model                               | Use `AgentHarness.create`, `nextRun`, lane/session v4 names, and the current options              |
| `AgentHarness.create()` rejects with `create.restore`      | The session contains durable records and restore is unfinished                       | Do not use the scaffold to restore that session                                                   |
| `streamProxy` loses finalized tool-call metadata           | Published `0.84.1` drops some final metadata, including OpenAI Responses namespaces  | Do not depend on it; patch the proxy path locally or wait for the upstream unreleased fix to ship |

## Debugging checklist

1. Confirm npm `latest`, then inspect the published README, declarations, and implementation.
2. Identify `Agent`, a low-level loop, direct session APIs, or the `AgentHarness` scaffold.
3. Confirm a required `streamFn` is present.
4. Check active-run state before `prompt()`, `continue()`, or `reset()`.
5. Inspect the transcript tail and queued input before continuation.
6. Filter visible streaming to text deltas.
7. Keep expected provider, conversion, transform, auth, and queue failures no-throw.
8. Confirm tool execution mode, hook replacement semantics, usage, added tools, and termination.
9. Account for awaited `Agent` listeners during settlement.
10. For harness work, inspect which methods are implemented in the published package. Do not infer readiness from types or design docs.
