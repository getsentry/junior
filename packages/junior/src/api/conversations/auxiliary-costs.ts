import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import type { ConversationAuxiliaryCosts } from "../schema/conversation";
import { notCopiedByFork } from "@/chat/conversations/fork";

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

/** Additive event costs of one Conversation and all its child agents. */
export interface ConversationTreeAuxiliaryCosts {
  total: ConversationAuxiliaryCosts;
  /** Part of the total that child agents spent, at any depth. */
  childAgentCostUsd?: number;
}

function addCostUsd(left: number, right: number): number {
  return Math.round((left + right) * 1e12) / 1e12;
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

  const scopeConversationId = conversationSubtreeColumns.scopeConversationId;
  const isChildAgent = sql<boolean>`(${conversationSubtreeColumns.conversationId} <> ${scopeConversationId})`;
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
  const rows = await db
    .select({
      conversationId: scopeConversationId,
      childAgentCostUsd:
        sql<number>`coalesce(round(sum(case when ${isChildAgent} then ${cost} end), 12), 0)::double precision`.mapWith(
          Number,
        ),
      costUsd: sql<number>`round(sum(${cost}), 12)::double precision`.mapWith(
        Number,
      ),
      events: sql<number>`count(*)::integer`.mapWith(Number),
      name,
      namespace,
    })
    .from(juniorConversationEvents)
    .innerJoin(
      conversationSubtree(conversationIds),
      eq(
        conversationSubtreeColumns.conversationId,
        juniorConversationEvents.conversationId,
      ),
    )
    .where(
      and(
        or(
          eq(juniorConversationEvents.type, "structured_event"),
          inArray(juniorConversationEvents.type, [
            "guardian_action_reviewed",
            "turn_routed",
          ]),
        ),
        sql`${cost} >= 0`,
        // A fork copies routing events, but their cost belongs to the source.
        notCopiedByFork(),
      ),
    )
    .groupBy(scopeConversationId, namespace, name)
    .orderBy(scopeConversationId, namespace, name);

  const result = new Map<string, ConversationTreeAuxiliaryCosts>();
  for (const row of rows) {
    const current = result.get(row.conversationId) ?? {
      total: { costUsd: 0, operations: [] },
    };
    current.total.costUsd = addCostUsd(current.total.costUsd, row.costUsd);
    if (row.childAgentCostUsd > 0) {
      current.childAgentCostUsd = addCostUsd(
        current.childAgentCostUsd ?? 0,
        row.childAgentCostUsd,
      );
    }
    current.total.operations.push({
      costUsd: row.costUsd,
      events: row.events,
      name: row.name,
      namespace: row.namespace,
    });
    result.set(row.conversationId, current);
  }
  return result;
}
