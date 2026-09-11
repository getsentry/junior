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

interface UsageTerm {
  factor: -1 | 1;
  usage: AgentTurnUsage | undefined;
}

function sumAgentTurnUsage(terms: UsageTerm[]): AgentTurnUsage | undefined {
  const components: AgentTurnUsage = {};
  let totalTokens = 0;
  let hasTokens = false;
  let hasOpaqueTokens = false;
  let reasoningTokens = 0;
  let hasReasoningTokens = false;
  const cost: AgentTurnCost = {};

  for (const { factor, usage } of terms) {
    if (!usage) continue;
    const componentTotal = getComponentTotal(usage);
    const usageTotal = componentTotal ?? getFiniteCount(usage.totalTokens);
    if (usageTotal !== undefined) {
      totalTokens += factor * usageTotal;
      hasTokens = true;
      hasOpaqueTokens ||= componentTotal === undefined;
    }
    if (componentTotal !== undefined) {
      for (const field of COMPONENT_USAGE_FIELDS) {
        const value = getFiniteCount(usage[field]);
        if (value === undefined) continue;
        components[field] = (components[field] ?? 0) + factor * value;
      }
    }

    const reasoning = getFiniteCount(usage.reasoningTokens);
    if (reasoning !== undefined) {
      reasoningTokens += factor * reasoning;
      hasReasoningTokens = true;
    }
    for (const field of [...COST_COMPONENT_FIELDS, "total"] as const) {
      const value = getFiniteCost(usage.cost?.[field]);
      if (value === undefined) continue;
      cost[field] = addCost(cost[field], factor * value);
    }
  }

  for (const field of COMPONENT_USAGE_FIELDS) {
    if (components[field] !== undefined) {
      components[field] = Math.max(0, components[field]);
    }
  }
  const result: AgentTurnUsage = hasOpaqueTokens
    ? { totalTokens: Math.max(0, totalTokens) }
    : components;
  if (hasTokens && !hasOpaqueTokens && Object.keys(components).length === 0) {
    result.totalTokens = Math.max(0, totalTokens);
  }
  if (hasReasoningTokens) {
    result.reasoningTokens = Math.max(0, reasoningTokens);
  }
  for (const field of [...COST_COMPONENT_FIELDS, "total"] as const) {
    if (cost[field] !== undefined) cost[field] = Math.max(0, cost[field]);
  }
  if (Object.keys(cost).length > 0) result.cost = cost;
  return hasAgentTurnUsage(result) ? result : undefined;
}

/** Replace one run's contribution in persisted Conversation usage. */
export function replaceAgentTurnUsage(args: {
  current: AgentTurnUsage | undefined;
  next: AgentTurnUsage;
  previous: AgentTurnUsage | undefined;
}): AgentTurnUsage | undefined {
  return sumAgentTurnUsage([
    { factor: 1, usage: args.current },
    { factor: -1, usage: args.previous },
    { factor: 1, usage: args.next },
  ]);
}

/** Aggregate token usage across slices without double-counting provider totals. */
export function addAgentTurnUsage(
  ...usages: Array<AgentTurnUsage | undefined>
): AgentTurnUsage | undefined {
  return sumAgentTurnUsage(
    usages.map((usage) => ({ factor: 1 as const, usage })),
  );
}
