import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ConversationReportStatus } from "@/api/schema/conversation";
import { reviewItemNeedsInput } from "@/chat/review-items/access";
import { juniorConversationEvents, juniorReviewItems } from "@/db/schema";

/** The `junior_conversations` columns, or an alias's, that status reads. */
export interface ConversationStatusColumns {
  conversationId: AnyPgColumn;
  executionStatus: AnyPgColumn;
  stoppedAt: AnyPgColumn;
}

/**
 * SQL for the status of one Conversation's own work. This is the only place
 * that derives it; readers, counts, feed tokens, and auto-archive select it.
 * When more than one applies: `active` > `stopped` > `failed` >
 * `needs_input` > `idle`.
 *
 * - `active`: execution is `pending`, `running`, or `paused`.
 * - `stopped`: `stopped_at` is set.
 * - `failed`: execution is `failed`, or the newest Turn lifecycle event is
 *   `turn_failed`. Events are durable; the Redis Turn record expires.
 * - `needs_input`: an open action Review item that this Conversation added
 *   waits for a person. A linked item from another Conversation does not.
 * - `idle`: anything else, such as a Turn that waits for sign-in or a parent
 *   that waits for its children.
 */
export function conversationStatusSql(
  conversation: ConversationStatusColumns,
): SQL<ConversationReportStatus> {
  // One max per type, so each reads the end of
  // `junior_conversation_events_type_idx (conversation_id, type, seq)`.
  const newestSeq = (type: string) =>
    sql`(select max(${juniorConversationEvents.seq}) from ${juniorConversationEvents} where ${and(
      eq(juniorConversationEvents.conversationId, conversation.conversationId),
      eq(juniorConversationEvents.type, type),
    )})`;
  // greatest() skips nulls; a Conversation with no started Turn reads -1.
  const lastTurnFailed = sql`${newestSeq("turn_failed")} > coalesce(greatest(${newestSeq("turn_started")}, ${newestSeq("turn_completed")}), -1)`;
  const needsInput = sql`exists (select 1 from ${juniorReviewItems} where ${and(
    eq(juniorReviewItems.addedByConversationId, conversation.conversationId),
    reviewItemNeedsInput(),
  )})`;
  // TODO(dcramer): Drop awaiting_resume with the store reader's alias for it.
  return sql<ConversationReportStatus>`case
    when ${conversation.executionStatus} in ('pending', 'running', 'paused', 'awaiting_resume') then 'active'
    when ${conversation.stoppedAt} is not null then 'stopped'
    when ${conversation.executionStatus} = 'failed' or ${lastTurnFailed} then 'failed'
    when ${needsInput} then 'needs_input'
    else 'idle'
  end`;
}
