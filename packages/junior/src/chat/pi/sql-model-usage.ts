/** SQL reporting adapter for usage stored on assistant history events. */
import { and, eq, sql, type SQL } from "drizzle-orm";
import * as z from "zod";
import { notInheritedByForkChild } from "@/chat/agent-invocations/fork-history";
import { notCopiedByFork } from "@/chat/conversations/fork";
import {
  readSubtreeEventWatermarks,
  seqRangeJoin,
  type SeqRange,
} from "@/chat/conversations/sql/event-watermarks";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  getStateAdapter,
  getStateValues,
  setStateValues,
} from "@/chat/state/adapter";
import { juniorConversationEvents } from "@/db/schema";
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

/** Sum assistant calls by Conversation and model id, in the seq range of each Conversation. */
async function sumModelUsage(
  executor: JuniorSqlDatabase,
  ranges: readonly SeqRange[],
): Promise<
  Array<ModelUsageSums & { conversationId: string; modelId: string }>
> {
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
  return await executor
    .db()
    .select({
      conversationId: juniorConversationEvents.conversationId,
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
    .innerJoin(...seqRangeJoin(ranges))
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
    .groupBy(juniorConversationEvents.conversationId, modelId);
}

// One entry per Conversation, not per subtree, with its own watermark. A
// root and its child agents then reuse the same entries.
const modelUsageCacheSchema = z.object({
  seq: z.number().int(),
  originMs: z.number(),
  models: z.record(z.string(), modelUsageSumsSchema),
});
type ModelUsageCache = z.infer<typeof modelUsageCacheSchema>;
// A read writes an entry only when its events changed. A miss after this TTL
// costs one full recompute, which is cheap for a Conversation that is idle.
const MODEL_USAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// v2 holds one Conversation. v1 held a whole subtree.
function modelUsageCacheKey(conversationId: string): string {
  return `conversation-model-usage:v2:${conversationId}`;
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

function mergeModels(
  target: ModelUsageCache["models"],
  models: ModelUsageCache["models"],
): void {
  for (const [modelId, sums] of Object.entries(models)) {
    target[modelId] = mergeSums(target[modelId], sums);
  }
}

/**
 * Aggregate real assistant calls by provider/model in SQL, for one
 * Conversation and all its child agents at any depth. Replayed history is not
 * another call; its tokens appear in the next call's input usage.
 *
 * Reading assistant payloads is slow on long Conversations, so each
 * Conversation in the subtree has its own cache entry. The entry keeps its
 * own watermark: the last seq that it counted and the creation time of the
 * first event (`originMs`). A read sums only the events after the seq of
 * each entry. Only a Conversation with no entry, or with an entry whose
 * watermark does not match, gets a full read of its own events. A read never
 * reads the whole subtree again. This is correct because a row at or below a
 * counted seq never changes and never changes whether it counts:
 * - Events are append-only. The per-Conversation event lock serializes
 *   appends and is held to commit, so when seq N is visible, lower seqs are.
 * - `notInheritedByForkChild` reads only lower seqs of the same Conversation.
 * - `notCopiedByFork` reads a later fork note of the same Conversation, but a
 *   fork commits its copied events and the note in one transaction.
 * So both rules depend only on the events of the entry's own Conversation.
 * A purge removes the events of a Conversation, and new events start again
 * at seq 0 with a new first event. A lower seq or another `originMs` does
 * not match the watermark, so a read rebuilds that Conversation's entry
 * only.
 * Concurrent reads can overwrite each other's entry. Each entry is correct
 * at its own seq, so the last write wins safely.
 */
export async function readConversationModelUsageFromSql(
  executor: JuniorSqlDatabase,
  options: { conversationId: string },
): Promise<Array<{ modelId: string; usage: AgentTurnUsage }>> {
  const watermarks = (
    await readSubtreeEventWatermarks(executor.db(), [options.conversationId])
  ).flatMap(({ conversationId, seq, originMs }) =>
    seq === null || originMs === null
      ? []
      : [{ conversationId, seq, originMs }],
  );
  const state = getStateAdapter();
  // One batched read for the whole subtree, not one per Conversation.
  const cachedValues = await getStateValues(
    state,
    watermarks.map(({ conversationId }) => modelUsageCacheKey(conversationId)),
  );
  const entries = watermarks.map((watermark, index) => {
    const cached = modelUsageCacheSchema.safeParse(cachedValues[index]).data;
    const base =
      cached &&
      cached.seq <= watermark.seq &&
      cached.originMs === watermark.originMs
        ? cached
        : undefined;
    return { base, watermark };
  });
  const ranges = entries.flatMap(({ base, watermark }) =>
    watermark.seq > (base?.seq ?? -1)
      ? [
          {
            conversationId: watermark.conversationId,
            fromSeq: base?.seq ?? -1,
            toSeq: watermark.seq,
          },
        ]
      : [],
  );
  const deltas = ranges.length > 0 ? await sumModelUsage(executor, ranges) : [];

  const models: ModelUsageCache["models"] = {};
  const writes: Array<{ key: string; value: ModelUsageCache }> = [];
  for (const { base, watermark } of entries) {
    const { conversationId, seq, originMs } = watermark;
    if (base && base.seq === seq) {
      mergeModels(models, base.models);
      continue;
    }
    const entryModels = { ...base?.models };
    for (const { conversationId: deltaId, modelId, ...sums } of deltas) {
      if (deltaId === conversationId) {
        entryModels[modelId] = mergeSums(entryModels[modelId], sums);
      }
    }
    mergeModels(models, entryModels);
    writes.push({
      key: modelUsageCacheKey(conversationId),
      value: { seq, originMs, models: entryModels },
    });
  }
  await setStateValues(state, writes, MODEL_USAGE_CACHE_TTL_MS);

  return Object.entries(models)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .flatMap(([modelId, sums]) => {
      const modelUsage = usageFromRow(sums);
      return modelUsage ? [{ modelId, usage: modelUsage }] : [];
    });
}
