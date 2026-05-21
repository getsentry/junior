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

const COMPONENT_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
] as const satisfies ReadonlyArray<keyof AgentTurnUsage>;

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

function getFiniteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function getComponentTotal(usage: AgentTurnUsage): number | undefined {
  let total: number | undefined;
  for (const field of COMPONENT_USAGE_FIELDS) {
    const value = getFiniteCount(usage[field]);
    if (value === undefined) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/** Aggregate token usage across slices without double-counting provider totals. */
export function addAgentTurnUsage(
  ...usages: Array<AgentTurnUsage | undefined>
): AgentTurnUsage | undefined {
  const components: AgentTurnUsage = {};
  let componentTotal: number | undefined;
  let totalOnlyTokens: number | undefined;

  for (const usage of usages) {
    if (!usage) continue;
    const usageComponentTotal = getComponentTotal(usage);
    if (usageComponentTotal !== undefined) {
      componentTotal = (componentTotal ?? 0) + usageComponentTotal;
      for (const field of COMPONENT_USAGE_FIELDS) {
        const value = getFiniteCount(usage[field]);
        if (value === undefined) continue;
        components[field] = (components[field] ?? 0) + value;
      }
      continue;
    }

    const totalTokens = getFiniteCount(usage.totalTokens);
    if (totalTokens !== undefined) {
      totalOnlyTokens = (totalOnlyTokens ?? 0) + totalTokens;
    }
  }

  if (totalOnlyTokens !== undefined) {
    return {
      totalTokens: totalOnlyTokens + (componentTotal ?? 0),
    };
  }

  return hasAgentTurnUsage(components) ? components : undefined;
}
