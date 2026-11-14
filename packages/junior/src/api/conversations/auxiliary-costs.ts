import { and, inArray, sql, type SQL } from "drizzle-orm";
import * as z from "zod";
import {
  readSubtreeEventWatermarks,
  seqRangeJoin,
  type ConversationEventWatermark,
  type SeqRange,
} from "@/chat/conversations/sql/event-watermarks";
import {
  getStateAdapter,
  getStateValues,
  setStateValues,
} from "@/chat/state/adapter";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import type { ConversationAuxiliaryCosts } from "../schema/conversation";
import { notCopiedByFork } from "@/chat/conversations/fork";
import { ACTION_DECIDED_EVENT_TYPES } from "@/chat/conversations/history";

// Core event types with a top-level `costUsd`. `turn_routed` rows come from
// the retired Turn router. They still carry the router cost of old Turns.
// `compaction` and `compaction_prepared` carry the cost of the summary
// requests. A swap of a prepared summary has no cost, so it does not count.
// Only Guardian's `action_decided` rows carry a cost.
const CORE_COST_EVENT_TYPES = [
  "compaction",
  "compaction_prepared",
  ...ACTION_DECIDED_EVENT_TYPES,
  "turn_routed",
] as const;

function eventCost(): SQL<number | null> {
  return sql<number | null>`CASE
    WHEN ${juniorConversationEvents.type} = 'structured_event'
      AND jsonb_typeof(${juniorConversationEvents.payload}->'content'->'costUsd') = 'number'
      THEN (${juniorConversationEvents.payload}->'content'->>'costUsd')::numeric
    WHEN ${inArray(juniorConversationEvents.type, [...CORE_COST_EVENT_TYPES])}
      AND jsonb_typeof(${juniorConversationEvents.payload}->'costUsd') = 'number'
      THEN (${juniorConversationEvents.payload}->>'costUsd')::numeric
    ELSE NULL
  END`;
}

/** Additive event costs of one Conversation and all its child agents. */
export interface ConversationTreeAuxiliaryCosts {
  total: ConversationAuxiliaryCosts;
  /** Part of the total that child agents spent, at any depth. */
  childAgentCostUsd?: number;
}

function addCostUsd(left: number, right: number): number {
  return Math.round((left + right) * 1e12) / 1e12;
}

// Match Postgres `ORDER BY` on these ASCII keys.
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Cost sums of one operation. Sums of two seq ranges add field by field. */
const operationSumsSchema = z.object({
  costUsd: z.number(),
  events: z.number().int(),
  name: z.string(),
  namespace: z.string(),
});
type OperationSums = z.infer<typeof operationSumsSchema>;

// One entry per Conversation, not per subtree. A list, a detail, and a child
// agent row then reuse the same entries.
const auxiliaryCostCacheSchema = z.object({
  seq: z.number().int(),
  originMs: z.number(),
  operations: z.array(operationSumsSchema),
});
type AuxiliaryCostCache = z.infer<typeof auxiliaryCostCacheSchema>;
// A read writes the entry only when events changed. A miss after this TTL
// costs one full recompute, which is cheap for a Conversation that is idle.
const AUXILIARY_COST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Change the version when the set of counted events changes. An entry that an
// older reader wrote can cover events that it did not count.
function auxiliaryCostCacheKey(conversationId: string): string {
  return `conversation-auxiliary-costs:v3:${conversationId}`;
}

function operationKey(operation: OperationSums): string {
  return `${operation.namespace}\u0000${operation.name}`;
}

function mergeOperations(
  operations: Iterable<OperationSums>,
): Map<string, OperationSums> {
  const merged = new Map<string, OperationSums>();
  for (const operation of operations) {
    const key = operationKey(operation);
    const current = merged.get(key);
    merged.set(
      key,
      current
        ? {
            ...current,
            costUsd: addCostUsd(current.costUsd, operation.costUsd),
            events: current.events + operation.events,
          }
        : operation,
    );
  }
  return merged;
}

/** Sum additive event costs by operation, in the seq range of each Conversation. */
async function sumOperationCosts(
  db: JuniorDatabase,
  ranges: readonly SeqRange[],
): Promise<Array<OperationSums & { conversationId: string }>> {
  const namespace = sql<string>`CASE
    WHEN ${juniorConversationEvents.type} = 'structured_event'
      THEN ${juniorConversationEvents.payload}->>'namespace'
    ELSE 'junior'
  END`;
  // Active and background summaries are one operation: compaction.
  const name = sql<string>`CASE
    WHEN ${juniorConversationEvents.type} = 'structured_event'
      THEN ${juniorConversationEvents.payload}->>'name'
    WHEN ${juniorConversationEvents.type} = 'compaction_prepared'
      THEN 'compaction'
    -- Old Guardian rows count as action_decided.
    WHEN ${juniorConversationEvents.type} = 'guardian_action_reviewed'
      THEN 'action_decided'
    ELSE ${juniorConversationEvents.type}
  END`;
  const cost = eventCost();
  return await db
    .select({
      conversationId: juniorConversationEvents.conversationId,
      costUsd: sql<number>`round(sum(${cost}), 12)::double precision`.mapWith(
        Number,
      ),
      events: sql<number>`count(*)::integer`.mapWith(Number),
      name,
      namespace,
    })
    .from(juniorConversationEvents)
    .innerJoin(...seqRangeJoin(ranges))
    .where(
      and(
        inArray(juniorConversationEvents.type, [
          "structured_event",
          ...CORE_COST_EVENT_TYPES,
        ]),
        sql`${cost} >= 0`,
        // A fork copies these events, but their cost belongs to the source.
        notCopiedByFork(),
      ),
    )
    .groupBy(juniorConversationEvents.conversationId, namespace, name);
}

/**
 * Read the cost operations of each Conversation, from its cache entry plus
 * the events after the cached seq. The entry is correct for the same reasons
 * as the model usage cache in `readConversationModelUsageFromSql`: events
 * are append-only and appends commit in seq order, and a fork commits its
 * copied events and its fork note in one transaction.
 */
async function readOperationsByConversation(
  db: JuniorDatabase,
  watermarks: readonly ConversationEventWatermark[],
): Promise<Map<string, OperationSums[]>> {
  const latest = new Map<string, { seq: number; originMs: number }>();
  for (const { conversationId, seq, originMs } of watermarks) {
    if (seq !== null && originMs !== null) {
      latest.set(conversationId, { seq, originMs });
    }
  }
  const state = getStateAdapter();
  const watermarkEntries = [...latest];
  // One batched read for the whole list, not one per Conversation.
  const cachedValues = await getStateValues(
    state,
    watermarkEntries.map(([conversationId]) =>
      auxiliaryCostCacheKey(conversationId),
    ),
  );
  const entries = watermarkEntries.map(([conversationId, watermark], index) => {
    const cached = auxiliaryCostCacheSchema.safeParse(cachedValues[index]).data;
    // A purged Conversation starts again at seq 0 with a new first event.
    const base =
      cached &&
      cached.seq <= watermark.seq &&
      cached.originMs === watermark.originMs
        ? cached
        : undefined;
    return { base, conversationId, watermark };
  });
  const ranges = entries.flatMap(({ base, conversationId, watermark }) =>
    watermark.seq > (base?.seq ?? -1)
      ? [{ conversationId, fromSeq: base?.seq ?? -1, toSeq: watermark.seq }]
      : [],
  );
  const deltas = ranges.length > 0 ? await sumOperationCosts(db, ranges) : [];

  const result = new Map<string, OperationSums[]>();
  const writes: Array<{ key: string; value: AuxiliaryCostCache }> = [];
  for (const { base, conversationId, watermark } of entries) {
    if (base && base.seq === watermark.seq) {
      result.set(conversationId, base.operations);
      continue;
    }
    const operations = [
      ...mergeOperations([
        ...(base?.operations ?? []),
        ...deltas.flatMap(({ conversationId: deltaId, ...operation }) =>
          deltaId === conversationId ? [operation] : [],
        ),
      ]).values(),
    ];
    result.set(conversationId, operations);
    writes.push({
      key: auxiliaryCostCacheKey(conversationId),
      value: { ...watermark, operations },
    });
  }
  await setStateValues(state, writes, AUXILIARY_COST_CACHE_TTL_MS);
  return result;
}

/**
 * Aggregate additive event costs by namespaced operation. The total for each
 * selected Conversation includes itself and all its child agents at any depth.
 */
export async function readConversationAuxiliaryCostsFromSql(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationTreeAuxiliaryCosts>> {
  if (conversationIds.length === 0) return new Map();

  const watermarks = await readSubtreeEventWatermarks(db, conversationIds);
  const operationsByConversation = await readOperationsByConversation(
    db,
    watermarks,
  );
  const membersByScope = new Map<string, string[]>();
  for (const { scopeConversationId, conversationId } of watermarks) {
    const members = membersByScope.get(scopeConversationId) ?? [];
    members.push(conversationId);
    membersByScope.set(scopeConversationId, members);
  }

  const result = new Map<string, ConversationTreeAuxiliaryCosts>();
  for (const [scopeConversationId, members] of membersByScope) {
    let childAgentCostUsd = 0;
    for (const member of members) {
      if (member === scopeConversationId) continue;
      for (const operation of operationsByConversation.get(member) ?? []) {
        childAgentCostUsd = addCostUsd(childAgentCostUsd, operation.costUsd);
      }
    }
    const operations = [
      ...mergeOperations(
        members.flatMap((member) => operationsByConversation.get(member) ?? []),
      ).values(),
    ].sort(
      (left, right) =>
        compareText(left.namespace, right.namespace) ||
        compareText(left.name, right.name),
    );
    if (operations.length === 0) continue;
    result.set(scopeConversationId, {
      total: {
        costUsd: operations.reduce(
          (total, operation) => addCostUsd(total, operation.costUsd),
          0,
        ),
        operations,
      },
      ...(childAgentCostUsd > 0 ? { childAgentCostUsd } : undefined),
    });
  }
  return result;
}
