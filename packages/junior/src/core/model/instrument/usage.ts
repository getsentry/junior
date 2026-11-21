// Port of `extractGenAiUsageAttributes` in chat/logging.ts for one model reply.
// Keep the two in step with the core-drift skill.
import type { AssistantMessage } from "@earendil-works/pi-ai";

function toFiniteTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : undefined;
}

// Chat rounds each cost sum to 12 decimal places.
function toCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1e12) / 1e12
    : undefined;
}

/** The gen_ai token and estimated USD cost attributes of one model reply. */
export function usageAttributes(
  message: Pick<AssistantMessage, "usage">,
): Record<string, number> {
  const { usage } = message;
  const inputTokens = toFiniteTokenCount(usage.input);
  const outputTokens = toFiniteTokenCount(usage.output);
  const cachedInputTokens = toFiniteTokenCount(usage.cacheRead);
  const cacheCreationTokens = toFiniteTokenCount(usage.cacheWrite);
  const reasoningTokens = toFiniteTokenCount(usage.reasoning);
  const counts = [inputTokens, cachedInputTokens, cacheCreationTokens].filter(
    (count) => count !== undefined,
  );
  const semanticInputTokens =
    counts.length > 0
      ? counts.reduce((sum, count) => sum + count, 0)
      : undefined;
  const cost = {
    input: toCost(usage.cost?.input),
    output: toCost(usage.cost?.output),
    cacheRead: toCost(usage.cost?.cacheRead),
    cacheWrite: toCost(usage.cost?.cacheWrite),
    total: toCost(usage.cost?.total),
  };

  return {
    ...(semanticInputTokens !== undefined
      ? { "gen_ai.usage.input_tokens": semanticInputTokens }
      : undefined),
    ...(outputTokens !== undefined
      ? { "gen_ai.usage.output_tokens": outputTokens }
      : undefined),
    ...(cachedInputTokens !== undefined
      ? { "gen_ai.usage.cache_read.input_tokens": cachedInputTokens }
      : undefined),
    ...(cacheCreationTokens !== undefined
      ? { "gen_ai.usage.cache_creation.input_tokens": cacheCreationTokens }
      : undefined),
    // Per-call ratio, because metric monitors cannot divide two sums.
    ...(cachedInputTokens !== undefined && semanticInputTokens
      ? {
          "gen_ai.usage.cache_hit_ratio":
            cachedInputTokens / semanticInputTokens,
        }
      : undefined),
    ...(reasoningTokens !== undefined
      ? { "gen_ai.usage.reasoning.output_tokens": reasoningTokens }
      : undefined),
    ...(cost.input !== undefined
      ? { "app.cost.input_usd": cost.input }
      : undefined),
    ...(cost.output !== undefined
      ? { "app.cost.output_usd": cost.output }
      : undefined),
    ...(cost.cacheRead !== undefined
      ? { "app.cost.cache_read_usd": cost.cacheRead }
      : undefined),
    ...(cost.cacheWrite !== undefined
      ? { "app.cost.cache_write_usd": cost.cacheWrite }
      : undefined),
    ...(cost.total !== undefined
      ? { "app.cost.total_usd": cost.total }
      : undefined),
  };
}
