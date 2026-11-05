/** SQL reporting adapter for usage stored on assistant history events. */
import { and, eq, sql, type SQL } from "drizzle-orm";
import * as z from "zod";
import { notInheritedByForkChild } from "@/chat/agent-invocations/fork-history";
import { notCopiedByFork } from "@/chat/conversations/fork";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import type { JuniorSqlDatabase } from "@/db/db";
import { getStateAdapter } from "@/chat/state/adapter";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import {
  agentTurnUsageSchema,
  hasAgentTurnUsage,
  type AgentTurnCost,
  type AgentTurnUsage,
} from "@/chat/usage";

// Read the payload fields once per row. Each `payload->...` detoasts the whole
// payload again, an assistant payload holds the full reply content, and this
// query has dozens of usage expressions per row.
const assistantCall = sql`jsonb_to_record(${juniorConversationEvents.payload})
  as assistant_call(provider jsonb, model jsonb, usage jsonb)`;
const provider = sql`assistant_call.provider`;
const model = sql`assistant_call.model`;
const usage = sql`assistant_call.usage`;
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

// Raw SQL sums of one model. Each field is a plain sum over assistant calls,
// so the sums of two seq ranges add field by field.
const modelUsageSumsSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cacheCreationTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costInput: z.number().nullable(),
  costOutput: z.number().nullable(),
  costCacheRead: z.number().nullable(),
  costCacheWrite: z.number().nullable(),
  costTotal: z.number().nullable(),
});
type ModelUsageSums = z.infer<typeof modelUsageSumsSchema>;
const COST_FIELDS = new Set<keyof ModelUsageSums>([
  "costInput",
  "costOutput",
  "costCacheRead",
  "costCacheWrite",
  "costTotal",
]);

function usageFromRow(row: ModelUsageSums): AgentTurnUsage | undefined {
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
      ? undefined
      : { reasoningTokens: row.reasoningTokens }),
    ...(row.totalTokens === null
      ? undefined
      : { totalTokens: row.totalTokens }),
    ...(Object.keys(definedCost).length > 0
      ? { cost: definedCost }
      : undefined),
  };
  return hasAgentTurnUsage(result)
    ? agentTurnUsageSchema.parse(result)
    : undefined;
}

interface SeqRange {
  conversationId: string;
  /** Exclusive. */
  fromSeq: number;
  /** Inclusive. */
  toSeq: number;
}

/** Sum assistant calls by model id, in the given seq range of each Conversation. */
async function sumModelUsage(
  executor: JuniorSqlDatabase,
  ranges: readonly SeqRange[],
): Promise<Array<ModelUsageSums & { modelId: string }>> {
  // Prefer the model field when it already carries a vendor prefix so usage keys
  // match configured model ids (openai/gpt-5.6-sol), not the transport
  // provider concatenated onto that id (vercel-ai-gateway/openai/gpt-5.6-sol).
  const modelText = sql`(${model} #>> '{}')`;
  const modelId = sql<string>`case
    when position('/' in coalesce(${modelText}, '')) > 0
      then ${modelText}
    else concat(${provider} #>> '{}', '/', ${modelText})
  end`;
  const inputTokens = token("input", "inputTokens");
  const outputTokens = token("output", "outputTokens");
  const cachedInputTokens = token("cacheRead", "cachedInputTokens");
  const cacheCreationTokens = token("cacheWrite", "cacheCreationTokens");
  const rangeRows = sql.join(
    ranges.map(
      (range) =>
        sql`(${range.conversationId}::text, ${range.fromSeq}::integer, ${range.toSeq}::integer)`,
    ),
    sql`, `,
  );
  return await executor
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
      sql`(values ${rangeRows}) as seq_range(conversation_id, from_seq, to_seq)`,
      sql`seq_range.conversation_id = ${juniorConversationEvents.conversationId}
        and ${juniorConversationEvents.seq} > seq_range.from_seq
        and ${juniorConversationEvents.seq} <= seq_range.to_seq`,
    )
    .crossJoinLateral(assistantCall)
    .where(
      and(
        eq(juniorConversationEvents.type, "assistant_message"),
        // Copied fork history is model context, not another model call.
        notCopiedByFork(),
        notInheritedByForkChild(),
        sql`jsonb_typeof(${provider}) = 'string'`,
        sql`jsonb_typeof(${model}) = 'string'`,
        sql`coalesce(${provider} #>> '{}', '') <> ''`,
        sql`coalesce(${modelText}, '') <> ''`,
      ),
    )
    .groupBy(modelId);
}

/**
 * The last event seq of each Conversation in a subtree, and the creation time
 * of its first event. A purged Conversation can get new events under the same
 * id, with seq starting again at 0; the first event time tells them apart.
 */
async function readEventWatermarks(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<
  Array<{ conversationId: string; seq: number | null; originMs: number | null }>
> {
  const conversation = juniorConversations.conversationId;
  return await executor
    .db()
    .select({
      conversationId: conversation,
      seq: sql<number | null>`(
        select max(watermark.seq) from junior_conversation_events watermark
        where watermark.conversation_id = ${conversation}
      )`,
      originMs: sql<number | null>`(
        select (extract(epoch from origin.created_at) * 1000)::double precision
        from junior_conversation_events origin
        where origin.conversation_id = ${conversation}
        order by origin.seq
        limit 1
      )`,
    })
    .from(juniorConversations)
    .innerJoin(
      conversationSubtree([conversationId]),
      eq(conversationSubtreeColumns.conversationId, conversation),
    );
}

const modelUsageCacheSchema = z.object({
  conversations: z.record(
    z.string(),
    z.object({ seq: z.number().int(), originMs: z.number() }),
  ),
  models: z.record(z.string(), modelUsageSumsSchema),
});
type ModelUsageCache = z.infer<typeof modelUsageCacheSchema>;
const EMPTY_MODEL_USAGE_CACHE: ModelUsageCache = {
  conversations: {},
  models: {},
};
// A read writes the entry only when events changed. A miss after this TTL
// costs one full recompute, which is cheap for a Conversation that is idle.
const MODEL_USAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function modelUsageCacheKey(conversationId: string): string {
  return `conversation-model-usage:${conversationId}`;
}

function addSums(
  field: keyof ModelUsageSums,
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  // Match the round(..., 12) of a full recompute.
  return COST_FIELDS.has(field)
    ? Number((left + right).toFixed(12))
    : left + right;
}

function mergeSums(
  left: ModelUsageSums | undefined,
  right: ModelUsageSums,
): ModelUsageSums {
  if (!left) return right;
  const merged = { ...right };
  for (const field of modelUsageSumsSchema.keyof().options) {
    merged[field] = addSums(field, left[field], right[field]);
  }
  return merged;
}

/**
 * Aggregate real assistant calls by provider/model in SQL, for one
 * Conversation and all its child agents at any depth. Replayed history is not
 * another call; its tokens appear in the next call's input usage.
 *
 * Reading assistant payloads is slow on long Conversations, so the sums are
 * cached with the last seq that each Conversation in the subtree added. A read
 * sums only later events. This is correct because a row at or below a seen
 * seq never changes and never changes whether it counts:
 * - Events are append-only. The per-Conversation event lock serializes
 *   appends and is held to commit, so when seq N is visible, lower seqs are.
 * - `notInheritedByForkChild` reads only lower seqs of the same Conversation.
 * - `notCopiedByFork` reads a later fork note, but a fork commits its copied
 *   events and the note in one transaction.
 * Concurrent reads can overwrite each other's entry. Each entry is correct
 * at its own seqs, so the last write wins safely.
 */
export async function readConversationModelUsageFromSql(
  executor: JuniorSqlDatabase,
  options: { conversationId: string },
): Promise<Array<{ modelId: string; usage: AgentTurnUsage }>> {
  const state = getStateAdapter();
  const key = modelUsageCacheKey(options.conversationId);
  const [stored, watermarks] = await Promise.all([
    state.get(key),
    readEventWatermarks(executor, options.conversationId),
  ]);
  const cached = modelUsageCacheSchema.safeParse(stored).data;
  // Purge removes the whole subtree's events, so rebuild all on any mismatch.
  const purged = watermarks.some(({ conversationId, seq, originMs }) => {
    const seen = cached?.conversations[conversationId];
    return (
      seen && (seq === null || seq < seen.seq || originMs !== seen.originMs)
    );
  });
  const base = cached && !purged ? cached : EMPTY_MODEL_USAGE_CACHE;
  const ranges: SeqRange[] = [];
  const conversations: ModelUsageCache["conversations"] = {};
  for (const { conversationId, seq, originMs } of watermarks) {
    if (seq === null || originMs === null) continue;
    conversations[conversationId] = { seq, originMs };
    const fromSeq = base.conversations[conversationId]?.seq ?? -1;
    if (seq > fromSeq) ranges.push({ conversationId, fromSeq, toSeq: seq });
  }

  let models = base.models;
  if (ranges.length > 0 || base !== cached) {
    const deltas =
      ranges.length > 0 ? await sumModelUsage(executor, ranges) : [];
    models = { ...base.models };
    for (const { modelId, ...sums } of deltas) {
      models[modelId] = mergeSums(models[modelId], sums);
    }
    await state.set(key, { conversations, models }, MODEL_USAGE_CACHE_TTL_MS);
  }

  return Object.entries(models)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .flatMap(([modelId, sums]) => {
      const modelUsage = usageFromRow(sums);
      return modelUsage ? [{ modelId, usage: modelUsage }] : [];
    });
}
