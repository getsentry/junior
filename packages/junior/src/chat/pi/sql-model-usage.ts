/** SQL reporting adapter for usage stored on assistant history events. */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import {
  agentTurnUsageSchema,
  hasAgentTurnUsage,
  type AgentTurnCost,
  type AgentTurnUsage,
} from "@/chat/usage";

const message = sql`${juniorConversationEvents.payload}`;
const usage = sql`${message}->'usage'`;
const cost = sql`${usage}->'cost'`;

function nonnegativeNumber(
  source: SQL,
  field: string,
  fallbackField?: string,
  floor = false,
): SQL<number | null> {
  const value = (name: string) =>
    sql`case
      when jsonb_typeof(${source}->${name}) = 'number'
        and (${source}->>${name})::numeric >= 0
      then ${floor ? sql`floor((${source}->>${name})::numeric)` : sql`(${source}->>${name})::numeric`}
    end`;
  const primary = value(field);
  return fallbackField
    ? sql<number | null>`coalesce(${primary}, ${value(fallbackField)})`
    : sql<number | null>`${primary}`;
}

function token(field: string, fallbackField?: string): SQL<number | null> {
  return nonnegativeNumber(usage, field, fallbackField, true);
}

function summed(value: SQL<number | null>): SQL<number | null> {
  return sql<number | null>`sum(${value})::double precision`;
}

function summedCost(value: SQL<number | null>): SQL<number | null> {
  return sql<number | null>`round(sum(${value}), 12)::double precision`;
}

function messageTotalTokens(args: {
  input: SQL<number | null>;
  output: SQL<number | null>;
  cacheRead: SQL<number | null>;
  cacheWrite: SQL<number | null>;
}): SQL<number | null> {
  const { input, output, cacheRead, cacheWrite } = args;
  return sql<number | null>`case
    when ${input} is not null
      or ${output} is not null
      or ${cacheRead} is not null
      or ${cacheWrite} is not null
    then coalesce(${input}, 0)
      + coalesce(${output}, 0)
      + coalesce(${cacheRead}, 0)
      + coalesce(${cacheWrite}, 0)
    else ${token("totalTokens")}
  end`;
}

function definedNumber(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

interface ModelUsageRow {
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costInput: number | null;
  costOutput: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  costTotal: number | null;
}

function usageFromRow(row: ModelUsageRow): AgentTurnUsage | undefined {
  const components = {
    inputTokens: definedNumber(row.inputTokens),
    outputTokens: definedNumber(row.outputTokens),
    cachedInputTokens: definedNumber(row.cachedInputTokens),
    cacheCreationTokens: definedNumber(row.cacheCreationTokens),
  };
  const costFields: AgentTurnCost = {
    input: definedNumber(row.costInput),
    output: definedNumber(row.costOutput),
    cacheRead: definedNumber(row.costCacheRead),
    cacheWrite: definedNumber(row.costCacheWrite),
    total: definedNumber(row.costTotal),
  };
  const definedCost = Object.fromEntries(
    Object.entries(costFields).filter(([, value]) => value !== undefined),
  ) as AgentTurnCost;
  const result: AgentTurnUsage = {
    ...Object.fromEntries(
      Object.entries(components).filter(([, value]) => value !== undefined),
    ),
    ...(row.reasoningTokens === null
      ? {}
      : { reasoningTokens: row.reasoningTokens }),
    ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }),
    ...(Object.keys(definedCost).length > 0 ? { cost: definedCost } : {}),
  };
  return hasAgentTurnUsage(result)
    ? agentTurnUsageSchema.parse(result)
    : undefined;
}

/**
 * Resolve the gateway model id stored on an assistant message.
 *
 * Vercel AI Gateway messages keep `provider` as the transport (`vercel-ai-gateway`)
 * and `model` as the vendor id (`openai/gpt-5.6-sol`). Older fixtures may store a
 * bare model name with a vendor provider; those still need `provider/model`.
 */
export function conversationModelIdFromAssistantFields(args: {
  model: string;
  provider: string;
}): string {
  return args.model.includes("/")
    ? args.model
    : `${args.provider}/${args.model}`;
}

/**
 * Aggregate real assistant calls by provider/model in SQL. Replayed history is
 * not another call; its tokens appear in the next call's input usage.
 */
export async function readConversationModelUsageFromSql(
  executor: JuniorSqlDatabase,
  options: { conversationId: string; includeDescendants?: boolean },
): Promise<Array<{ modelId: string; usage: AgentTurnUsage }>> {
  // Prefer the model field when it already carries a vendor prefix so usage keys
  // match turn_routed/handoff model ids (openai/gpt-5.6-sol), not the transport
  // provider concatenated onto that id (vercel-ai-gateway/openai/gpt-5.6-sol).
  const modelId = sql<string>`case
    when position('/' in coalesce(${message}->>'model', '')) > 0
      then ${message}->>'model'
    else concat(${message}->>'provider', '/', ${message}->>'model')
  end`;
  const inputTokens = token("input", "inputTokens");
  const outputTokens = token("output", "outputTokens");
  const cachedInputTokens = token("cacheRead", "cachedInputTokens");
  const cacheCreationTokens = token("cacheWrite", "cacheCreationTokens");
  const rows: ModelUsageRow[] = await executor
    .db()
    .select({
      modelId,
      inputTokens: summed(inputTokens),
      outputTokens: summed(outputTokens),
      cachedInputTokens: summed(cachedInputTokens),
      cacheCreationTokens: summed(cacheCreationTokens),
      reasoningTokens: summed(token("reasoning", "reasoningTokens")),
      totalTokens: summed(
        messageTotalTokens({
          input: inputTokens,
          output: outputTokens,
          cacheRead: cachedInputTokens,
          cacheWrite: cacheCreationTokens,
        }),
      ),
      costInput: summedCost(nonnegativeNumber(cost, "input")),
      costOutput: summedCost(nonnegativeNumber(cost, "output")),
      costCacheRead: summedCost(nonnegativeNumber(cost, "cacheRead")),
      costCacheWrite: summedCost(nonnegativeNumber(cost, "cacheWrite")),
      costTotal: summedCost(nonnegativeNumber(cost, "total")),
    })
    .from(juniorConversationEvents)
    .innerJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorConversationEvents.conversationId,
      ),
    )
    .where(
      and(
        options.includeDescendants
          ? eq(juniorConversations.rootConversationId, options.conversationId)
          : eq(juniorConversationEvents.conversationId, options.conversationId),
        eq(juniorConversationEvents.type, "assistant_message"),
        sql`jsonb_typeof(${message}->'provider') = 'string'`,
        sql`jsonb_typeof(${message}->'model') = 'string'`,
        sql`coalesce(${message}->>'provider', '') <> ''`,
        sql`coalesce(${message}->>'model', '') <> ''`,
      ),
    )
    .groupBy(modelId)
    .orderBy(modelId);

  return rows.flatMap((row) => {
    const modelUsage = usageFromRow(row);
    return modelUsage ? [{ modelId: row.modelId, usage: modelUsage }] : [];
  });
}
