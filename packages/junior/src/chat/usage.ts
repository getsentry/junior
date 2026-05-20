/**
 * Structured token usage captured for a single agent turn.
 *
 * Mirrors the fields pi-ai emits on `AssistantMessage.usage` (see
 * `@mariozechner/pi-ai` `Usage`) so diagnostics carry every counter the
 * provider normalizes into the pi-ai shape as its own item. Renderers decide
 * whether to display a breakdown or a single aggregate.
 */
export interface AgentTurnUsage {
  /** Non-cached input tokens; OTel `gen_ai.usage.input_tokens` adds cache counters back in. */
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

/** Return whether any token counter is present on a usage record. */
export function hasAgentTurnUsage(
  usage: AgentTurnUsage | undefined,
): usage is AgentTurnUsage {
  return Boolean(
    usage &&
    Object.values(usage).some(
      (value) => typeof value === "number" && Number.isFinite(value),
    ),
  );
}

/** Sum token counters across turn slices while preserving absent fields. */
export function addAgentTurnUsage(
  ...usages: Array<AgentTurnUsage | undefined>
): AgentTurnUsage | undefined {
  const total: AgentTurnUsage = {};
  for (const usage of usages) {
    if (!usage) continue;
    for (const field of Object.keys(usage) as (keyof AgentTurnUsage)[]) {
      const value = usage[field];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      total[field] = (total[field] ?? 0) + value;
    }
  }
  return hasAgentTurnUsage(total) ? total : undefined;
}
