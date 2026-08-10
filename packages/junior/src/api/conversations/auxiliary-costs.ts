import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import type { ConversationAuxiliaryCosts } from "../schema/conversation";

const auxiliaryRootConversation = alias(
  juniorConversations,
  "auxiliary_root_conversation",
);

function eventCost(): SQL<number | null> {
  return sql<number | null>`CASE
    WHEN ${juniorConversationEvents.type} = 'structured_event'
      AND jsonb_typeof(${juniorConversationEvents.payload}->'content'->'costUsd') = 'number'
      THEN (${juniorConversationEvents.payload}->'content'->>'costUsd')::numeric
    WHEN ${juniorConversationEvents.type} IN ('guardian_action_reviewed', 'turn_routed')
      AND jsonb_typeof(${juniorConversationEvents.payload}->'costUsd') = 'number'
      THEN (${juniorConversationEvents.payload}->>'costUsd')::numeric
    ELSE NULL
  END`;
}

/** Aggregate additive event costs by namespaced operation for conversations. */
export async function readConversationAuxiliaryCostsFromSql(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  options: { includeDescendants: boolean },
): Promise<Map<string, ConversationAuxiliaryCosts>> {
  if (conversationIds.length === 0) return new Map();

  const selectedIds = [...conversationIds];
  const conversationId = options.includeDescendants
    ? sql<string>`coalesce(
        ${auxiliaryRootConversation.conversationId},
        ${juniorConversations.conversationId}
      )`
    : sql<string>`${juniorConversations.conversationId}`;
  const namespace = sql<string>`CASE
    WHEN ${juniorConversationEvents.type} = 'structured_event'
      THEN ${juniorConversationEvents.payload}->>'namespace'
    ELSE 'junior'
  END`;
  const name = sql<string>`CASE
    WHEN ${juniorConversationEvents.type} = 'structured_event'
      THEN ${juniorConversationEvents.payload}->>'name'
    ELSE ${juniorConversationEvents.type}
  END`;
  const cost = eventCost();
  const selectedConversation = options.includeDescendants
    ? or(
        and(
          inArray(juniorConversations.rootConversationId, selectedIds),
          isNotNull(auxiliaryRootConversation.conversationId),
        ),
        inArray(juniorConversations.conversationId, selectedIds),
      )
    : inArray(juniorConversations.conversationId, selectedIds);
  const rows = await db
    .select({
      conversationId,
      costUsd: sql<number>`round(sum(${cost}), 12)::double precision`.mapWith(
        Number,
      ),
      events: sql<number>`count(*)::integer`.mapWith(Number),
      name,
      namespace,
    })
    .from(juniorConversationEvents)
    .innerJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorConversationEvents.conversationId,
      ),
    )
    .leftJoin(
      auxiliaryRootConversation,
      and(
        eq(
          auxiliaryRootConversation.conversationId,
          juniorConversations.rootConversationId,
        ),
        isNull(auxiliaryRootConversation.parentConversationId),
        eq(
          auxiliaryRootConversation.rootConversationId,
          auxiliaryRootConversation.conversationId,
        ),
      ),
    )
    .where(
      and(
        selectedConversation,
        or(
          eq(juniorConversationEvents.type, "structured_event"),
          inArray(juniorConversationEvents.type, [
            "guardian_action_reviewed",
            "turn_routed",
          ]),
        ),
        sql`${cost} >= 0`,
      ),
    )
    .groupBy(conversationId, namespace, name)
    .orderBy(conversationId, namespace, name);

  const result = new Map<string, ConversationAuxiliaryCosts>();
  for (const row of rows) {
    const current = result.get(row.conversationId) ?? {
      costUsd: 0,
      operations: [],
    };
    current.costUsd = Math.round((current.costUsd + row.costUsd) * 1e12) / 1e12;
    current.operations.push({
      costUsd: row.costUsd,
      events: row.events,
      name: row.name,
      namespace: row.namespace,
    });
    result.set(row.conversationId, current);
  }
  return result;
}
