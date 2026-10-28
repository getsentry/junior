import { eq, sql, type SQL } from "drizzle-orm";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import {
  addAgentTurnUsage,
  hasAgentTurnUsage,
  type AgentTurnCost,
  type AgentTurnUsage,
} from "@/chat/usage";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import type { ConversationChildAgentTotals } from "../schema/child-agent-totals";
import type { ConversationTreeAuxiliaryCosts } from "./auxiliary-costs";

const usage = juniorConversations.usage;
const componentFields = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
] as const satisfies ReadonlyArray<keyof AgentTurnUsage>;

function summedUsageNumber(field: string): SQL<number | null> {
  return sql<
    number | null
  >`sum((${usage}->>${field})::double precision)::double precision`;
}

function summedCostNumber(field: string): SQL<number | null> {
  return sql<number | null>`round(
    sum((${usage}->'cost'->>${field})::numeric),
    12
  )::double precision`;
}

interface UsageAggregateRow {
  scopeConversationId: string;
  isChildAgent: boolean;
  conversations: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  totalOnlyTokens: number | null;
  reasoningTokens: number | null;
  costInput: number | null;
  costOutput: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  costTotal: number | null;
}

function usageFromAggregate(
  row: UsageAggregateRow,
): AgentTurnUsage | undefined {
  const components: AgentTurnUsage = {};
  let componentTotal = 0;
  for (const field of componentFields) {
    const value = row[field];
    if (value === null) continue;
    components[field] = value;
    componentTotal += value;
  }
  const cost: AgentTurnCost = {
    ...(row.costInput === null ? undefined : { input: row.costInput }),
    ...(row.costOutput === null ? undefined : { output: row.costOutput }),
    ...(row.costCacheRead === null ? undefined : { cacheRead: row.costCacheRead }),
    ...(row.costCacheWrite === null ? undefined : { cacheWrite: row.costCacheWrite }),
    ...(row.costTotal === null ? undefined : { total: row.costTotal }),
  };
  const result: AgentTurnUsage = {
    ...(row.totalOnlyTokens === null
      ? components
      : { totalTokens: row.totalOnlyTokens + componentTotal }),
    ...(row.reasoningTokens === null
      ? undefined
      : { reasoningTokens: row.reasoningTokens }),
    ...(Object.keys(cost).length === 0 ? undefined : { cost }),
  };
  return hasAgentTurnUsage(result) ? result : undefined;
}

/** Saved work of all child agents below one Conversation, at any depth. */
export interface ChildAgentMetrics {
  /** Number of child Conversations below the Conversation. */
  count: number;
  durationMs: number;
  usage?: AgentTurnUsage;
}

/** Saved work of one Conversation and all its child agents. */
export interface ConversationTreeMetrics {
  durationMs: number;
  usage?: AgentTurnUsage;
  /** Present only when the Conversation has child agents. */
  childAgents?: ChildAgentMetrics;
}

/**
 * Aggregate saved runtime and usage in PostgreSQL. The total for each selected
 * Conversation includes itself and all its child agents at any depth.
 */
export async function readConversationTreeMetricsFromSql(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationTreeMetrics>> {
  if (conversationIds.length === 0) return new Map();

  const hasComponents = sql`coalesce(
    ${usage}->>'inputTokens',
    ${usage}->>'outputTokens',
    ${usage}->>'cachedInputTokens',
    ${usage}->>'cacheCreationTokens'
  ) is not null`;
  const isChildAgent = sql<boolean>`(${conversationSubtreeColumns.conversationId} <> ${conversationSubtreeColumns.scopeConversationId})`;
  const rows: UsageAggregateRow[] = await db
    .select({
      scopeConversationId: conversationSubtreeColumns.scopeConversationId,
      isChildAgent,
      conversations: sql<number>`count(*)::integer`.mapWith(Number),
      durationMs: sql<number>`coalesce(sum(${juniorConversations.durationMs}), 0)::double precision`,
      inputTokens: summedUsageNumber("inputTokens"),
      outputTokens: summedUsageNumber("outputTokens"),
      cachedInputTokens: summedUsageNumber("cachedInputTokens"),
      cacheCreationTokens: summedUsageNumber("cacheCreationTokens"),
      totalOnlyTokens: sql<number | null>`sum(
        case
          when not (${hasComponents})
          then (${usage}->>'totalTokens')::double precision
        end
      )::double precision`,
      reasoningTokens: summedUsageNumber("reasoningTokens"),
      costInput: summedCostNumber("input"),
      costOutput: summedCostNumber("output"),
      costCacheRead: summedCostNumber("cacheRead"),
      costCacheWrite: summedCostNumber("cacheWrite"),
      costTotal: summedCostNumber("total"),
    })
    .from(juniorConversations)
    .innerJoin(
      conversationSubtree(conversationIds),
      eq(
        conversationSubtreeColumns.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .groupBy(conversationSubtreeColumns.scopeConversationId, isChildAgent);

  const ownRows = new Map<string, UsageAggregateRow>();
  const childRows = new Map<string, UsageAggregateRow>();
  for (const row of rows) {
    (row.isChildAgent ? childRows : ownRows).set(row.scopeConversationId, row);
  }
  const result = new Map<string, ConversationTreeMetrics>();
  for (const [conversationId, own] of ownRows) {
    const ownUsage = usageFromAggregate(own);
    const child = childRows.get(conversationId);
    const childUsage = child ? usageFromAggregate(child) : undefined;
    const usage = addAgentTurnUsage(ownUsage, childUsage);
    result.set(conversationId, {
      durationMs: own.durationMs + (child?.durationMs ?? 0),
      ...(usage ? { usage } : undefined),
      ...(child
        ? {
            childAgents: {
              count: child.conversations,
              durationMs: child.durationMs,
              ...(childUsage ? { usage: childUsage } : undefined),
            },
          }
        : undefined),
    });
  }
  return result;
}

/**
 * Project the child agent part of tree metrics into the API shape. Return
 * nothing when the Conversation has no child agents.
 */
export function childAgentTotalsReport(
  metrics: ConversationTreeMetrics | undefined,
  auxiliaryCosts?: ConversationTreeAuxiliaryCosts,
): ConversationChildAgentTotals | undefined {
  const childAgents = metrics?.childAgents;
  if (!childAgents) return undefined;
  return {
    ...(auxiliaryCosts?.childAgentCostUsd === undefined
      ? undefined
      : { auxiliaryCostUsd: auxiliaryCosts.childAgentCostUsd }),
    count: childAgents.count,
    cumulativeDurationMs: childAgents.durationMs,
    ...(childAgents.usage ? { cumulativeUsage: childAgents.usage } : undefined),
  };
}
