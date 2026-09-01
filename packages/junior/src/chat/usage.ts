import { usageCostSchema, usageSchema } from "@/usage-schema";
import type { Usage, UsageCost } from "@/usage-schema";

export const agentTurnCostSchema = usageCostSchema;

/** Estimated USD cost reported by pi-ai for one or more model calls. */
export type AgentTurnCost = UsageCost;

export const agentTurnUsageSchema = usageSchema;

/**
 * Structured token and cost usage captured for a single agent turn.
 *
 * Mirrors the fields pi-ai emits on `AssistantMessage.usage` (see
 * `@earendil-works/pi-ai` `Usage`) so diagnostics carry every counter the
 * provider normalizes into the pi-ai shape as its own item. Renderers decide
 * whether to display a breakdown or a single aggregate.
 */
export type AgentTurnUsage = Usage;

const COMPONENT_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
] as const satisfies ReadonlyArray<keyof AgentTurnUsage>;

const COST_COMPONENT_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const satisfies ReadonlyArray<keyof AgentTurnCost>;

/** Return whether any token counter is present on a usage record. */
export function hasAgentTurnUsage(
  usage: AgentTurnUsage | undefined,
): usage is AgentTurnUsage {
  return Boolean(
    usage &&
    (Object.entries(usage).some(
      ([field, value]) =>
        field !== "cost" && typeof value === "number" && Number.isFinite(value),
    ) ||
      Object.values(usage.cost ?? {}).some(
        (value) => typeof value === "number" && Number.isFinite(value),
      )),
  );
}

function getFiniteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function getFiniteCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function addCost(left: number | undefined, right: number): number {
  return Math.round(((left ?? 0) + right) * 1e12) / 1e12;
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

/** Estimated total USD cost from one usage record, when any cost field is present. */
export function agentTurnCostUsd(
  usage: AgentTurnUsage | undefined,
): number | undefined {
  if (!usage?.cost) return undefined;
  const total = getFiniteCost(usage.cost.total);
  if (total !== undefined) return total;
  let componentTotal = 0;
  let hasComponent = false;
  for (const field of COST_COMPONENT_FIELDS) {
    const value = getFiniteCost(usage.cost[field]);
    if (value === undefined) continue;
    hasComponent = true;
    componentTotal = addCost(componentTotal, value);
  }
  return hasComponent ? componentTotal : undefined;
}

/** Total token count from one usage record, preferring component counters. */
export function agentTurnTotalTokens(
  usage: AgentTurnUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  const componentTotal = getComponentTotal(usage);
  if (componentTotal !== undefined) return componentTotal;
  return getFiniteCount(usage.totalTokens);
}

/** Aggregate token usage across slices without double-counting provider totals. */
export function addAgentTurnUsage(
  ...usages: Array<AgentTurnUsage | undefined>
): AgentTurnUsage | undefined {
  const components: AgentTurnUsage = {};
  let componentTotal: number | undefined;
  let totalOnlyTokens: number | undefined;
  let reasoningTokens: number | undefined;
  const cost: AgentTurnCost = {};

  for (const usage of usages) {
    if (!usage) continue;
    const reasoning = getFiniteCount(usage.reasoningTokens);
    if (reasoning !== undefined) {
      reasoningTokens = (reasoningTokens ?? 0) + reasoning;
    }
    if (usage.cost) {
      for (const field of [...COST_COMPONENT_FIELDS, "total"] as const) {
        const value = getFiniteCost(usage.cost[field]);
        if (value === undefined) continue;
        cost[field] = addCost(cost[field], value);
      }
    }
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
      ...(reasoningTokens !== undefined ? { reasoningTokens } : undefined),
      ...(Object.keys(cost).length > 0 ? { cost } : undefined),
    };
  }

  const result: AgentTurnUsage = {
    ...components,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : undefined),
    ...(Object.keys(cost).length > 0 ? { cost } : undefined),
  };
  return hasAgentTurnUsage(result) ? result : undefined;
}
