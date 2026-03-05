# Common Use Cases

Use these patterns when Pi `Agent` is consumed by another library/runtime.

1. Stream assistant text into another SDK surface:
Use `agent.subscribe` and forward only `message_update` + `text_delta` into an `AsyncIterable<string>` bridge.

2. Preserve streamed-vs-final output parity:
Insert separators between assistant message boundaries during delta streaming so final joined text matches non-streamed output semantics.

3. Add custom app messages without leaking them to LLM calls:
Keep custom message types in agent state; filter/convert them in `convertToLlm`.

4. Prune or augment context safely:
Use `transformContext` for context window control and deterministic context injection before `convertToLlm`.

5. Support user steering while tools are running:
Use `steer` for interruptions and `followUp` for deferred prompts instead of issuing parallel `prompt()` calls.

6. Implement timeout-controlled turns:
Race prompt execution against a timeout, call `agent.abort()` on timeout, and surface explicit timeout diagnostics.

7. Resume across session slices/checkpoints:
Restore message history (for example via `replaceMessages`) and call `continue()` with valid tail-state semantics.

8. Route through backend-proxied model access:
Provide a custom `streamFn` (or `streamProxy`) so auth/provider calls stay server-side while preserving local `Agent` event semantics.

9. Handle expiring provider tokens:
Use `getApiKey` dynamic resolution for each LLM call instead of static long-lived API keys.

10. Tune transport/retry constraints:
Set `transport` and `maxRetryDelayMs` intentionally for consumer runtime behavior and bounded latency.
