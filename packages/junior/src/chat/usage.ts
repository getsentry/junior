/**
 * Structured token usage captured for a single agent turn.
 *
 * Mirrors the fields pi-ai emits on `AssistantMessage.usage` (see
 * `@mariozechner/pi-ai` `Usage`) so diagnostics carry every counter the
 * provider normalizes into the pi-ai shape as its own item. Renderers decide
 * whether to display a breakdown or a single aggregate.
 */
export interface AgentTurnUsage {
  /** Non-cached input tokens (pi-ai subtracts cached tokens from this). */
  inputTokens?: number;
  /** Output tokens; pi-ai folds reasoning tokens into this for providers that report them. */
  outputTokens?: number;
  /** Cached input tokens read from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Input tokens written into the provider's prompt cache. */
  cacheCreationTokens?: number;
  /** Provider-reported total. May not equal the sum of individual counters across providers. */
  totalTokens?: number;
}
