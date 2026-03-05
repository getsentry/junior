# Troubleshooting and Workarounds

Use this table when Pi-agent integration behavior is wrong in a consumer library.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `prompt()` throws "Agent is already processing a prompt..." | Concurrent prompt while `isStreaming` is true | Queue input with `steer`/`followUp` or await existing run completion |
| `continue()` throws while agent is active | `continue()` called during streaming | Wait for idle, then call `continue()` |
| `continue()` throws "No messages to continue from" | Empty message history | Seed context with user/toolResult history before `continue()` |
| `continue()` throws from assistant-tail state | No queued steering/follow-up messages when tail is assistant | Queue `steer`/`followUp` first, or call `prompt()` with new user message |
| Stream shows no text even though turn finishes | Listener filtering wrong event type | Consume `message_update` events with `assistantMessageEvent.type === "text_delta"` |
| Streamed text and final text differ in formatting | Missing boundaries between assistant message segments | Insert explicit separators between message boundaries and normalize downstream |
| Tool call artifacts leak into user-visible output | Consumer is rendering tool calls/tool results directly | Keep tool lifecycle artifacts internal and render only resolved assistant text |
| Custom message roles break provider calls | `convertToLlm` passes non-LLM-compatible roles | Filter/transform to provider-compatible message roles in `convertToLlm` |
| Context pruning removes critical state unexpectedly | `transformContext` is non-deterministic or too aggressive | Make pruning deterministic and test with before/after context assertions |
| Queue order surprises in multi-message steering | Queue mode defaults not explicit | Set `steeringMode`/`followUpMode` intentionally (`one-at-a-time` vs `all`) |
| Timeouts do not cleanly stop UI stream | Timeout path does not call `abort()` and close stream bridge | Abort agent on timeout, always end iterable in `finally` |
| Proxy streaming errors are opaque | Proxy response/event parsing not surfaced | Validate proxy response status/body and emit explicit error diagnostics |

## Issue/fix checklist

1. Concurrent prompt failure:
Use `steer`/`followUp` during active runs; do not call `prompt` again until idle.

2. Continue during stream:
Gate `continue()` with `isStreaming`/`waitForIdle()` checks.

3. Empty continue context:
Load prior `AgentMessage[]` before `continue()` calls.

4. Assistant-tail continue rejection:
Queue a steering or follow-up message first, or start a fresh prompt.

5. Missing text deltas:
Filter to `message_update` + `text_delta`; ignore other delta types for user text stream.

6. Stream/final mismatch:
Insert message-boundary separators and apply identical normalization in streamed and final output paths.

7. Invalid custom roles at provider boundary:
Map custom messages in `convertToLlm`; keep only provider-compatible roles.

8. Over-pruned context:
Make `transformContext` deterministic and verify retained messages in tests.

9. Queue-order surprises:
Set `steeringMode` and `followUpMode` explicitly in wrappers.

10. Timeout leak:
Always abort and close iterable in `finally` blocks.
