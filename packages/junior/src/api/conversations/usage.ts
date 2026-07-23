import { and, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  hasAgentTurnUsage,
  type AgentTurnCost,
  type AgentTurnUsage,
} from "@/chat/usage";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";

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
  rootConversationId: string | null;
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
    ...(row.costInput === null ? {} : { input: row.costInput }),
    ...(row.costOutput === null ? {} : { output: row.costOutput }),
    ...(row.costCacheRead === null ? {} : { cacheRead: row.costCacheRead }),
    ...(row.costCacheWrite === null ? {} : { cacheWrite: row.costCacheWrite }),
    ...(row.costTotal === null ? {} : { total: row.costTotal }),
  };
  const result: AgentTurnUsage = {
    ...(row.totalOnlyTokens === null
      ? components
      : { totalTokens: row.totalOnlyTokens + componentTotal }),
    ...(row.reasoningTokens === null
      ? {}
      : { reasoningTokens: row.reasoningTokens }),
    ...(Object.keys(cost).length === 0 ? {} : { cost }),
  };
  return hasAgentTurnUsage(result) ? result : undefined;
}

/** Aggregate persisted usage in PostgreSQL for selected conversation trees. */
export async function readRootConversationUsageFromSql(
  db: JuniorDatabase,
  rootConversationIds: readonly string[],
): Promise<Map<string, AgentTurnUsage>> {
  if (rootConversationIds.length === 0) return new Map();

  const hasComponents = sql`coalesce(
    ${usage}->>'inputTokens',
    ${usage}->>'outputTokens',
    ${usage}->>'cachedInputTokens',
    ${usage}->>'cacheCreationTokens'
  ) is not null`;
  const rows: UsageAggregateRow[] = await db
    .select({
      rootConversationId: juniorConversations.rootConversationId,
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
    .where(
      and(
        inArray(juniorConversations.rootConversationId, [
          ...rootConversationIds,
        ]),
        isNotNull(juniorConversations.usage),
      ),
    )
    .groupBy(juniorConversations.rootConversationId);

  return new Map(
    rows.flatMap((row) => {
      const aggregate = usageFromAggregate(row);
      return row.rootConversationId && aggregate
        ? [[row.rootConversationId, aggregate]]
        : [];
    }),
  );
}
