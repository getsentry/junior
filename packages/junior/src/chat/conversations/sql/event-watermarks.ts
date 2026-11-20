import { eq, sql, type SQL } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { conversationSubtree, conversationSubtreeColumns } from "./subtree";

/** How far one Conversation's events go, for caches that sum events once. */
export interface ConversationEventWatermark {
  /** The selected Conversation whose subtree has this Conversation. */
  scopeConversationId: string;
  conversationId: string;
  /** The last event seq, or null when the Conversation has no events. */
  seq: number | null;
  /**
   * Creation time of the first event. A purged Conversation can get new
   * events under the same id, with seq starting again at 0. This time tells
   * them apart.
   */
  originMs: number | null;
}

/**
 * Read the event watermark of each selected Conversation and each of its
 * child agents at any depth. Two primary key lookups per Conversation.
 */
export async function readSubtreeEventWatermarks(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<ConversationEventWatermark[]> {
  const conversation = juniorConversations.conversationId;
  return await db
    .select({
      scopeConversationId: conversationSubtreeColumns.scopeConversationId,
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
      conversationSubtree(conversationIds),
      eq(conversationSubtreeColumns.conversationId, conversation),
    );
}

/** Events after one watermark of a Conversation, up to the next one. */
export interface SeqRange {
  conversationId: string;
  /** Exclusive. */
  fromSeq: number;
  /** Inclusive. */
  toSeq: number;
}

/**
 * Arguments for `innerJoin` that keep only the events inside the seq range of
 * their Conversation. The range is in the index condition, so a read touches
 * only the new events.
 */
export function seqRangeJoin(ranges: readonly SeqRange[]): [SQL, SQL] {
  const rows = sql.join(
    ranges.map(
      (range) =>
        sql`(${range.conversationId}::text, ${range.fromSeq}::integer, ${range.toSeq}::integer)`,
    ),
    sql`, `,
  );
  return [
    sql`(values ${rows}) as seq_range(conversation_id, from_seq, to_seq)`,
    sql`seq_range.conversation_id = ${juniorConversationEvents.conversationId}
      and ${juniorConversationEvents.seq} > seq_range.from_seq
      and ${juniorConversationEvents.seq} <= seq_range.to_seq`,
  ];
}
