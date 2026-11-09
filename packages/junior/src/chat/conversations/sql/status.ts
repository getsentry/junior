import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ConversationReportStatus } from "@/api/schema/conversation";
import { reviewItemNeedsInput } from "@/chat/review-items/access";
import { juniorReviewItems } from "@/db/schema";

/** The `junior_conversations` columns, or an alias's, that status reads. */
export interface ConversationStatusColumns {
  conversationId: AnyPgColumn;
  executionStatus: AnyPgColumn;
  failedTurnId: AnyPgColumn;
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
 * - `failed`: execution is `failed`, or the latest Turn ended `turn_failed`.
 * - `needs_input`: an open action Review item that this Conversation added
 *   waits for a person. A linked item from another Conversation does not.
 * - `idle`: anything else, such as a Turn that waits for sign-in or a parent
 *   that waits for its children.
 */
export function conversationStatusSql(
  conversation: ConversationStatusColumns,
): SQL<ConversationReportStatus> {
  const needsInput = sql`exists (select 1 from ${juniorReviewItems} where ${and(
    eq(juniorReviewItems.addedByConversationId, conversation.conversationId),
    reviewItemNeedsInput(),
  )})`;
  return sql<ConversationReportStatus>`case
    when ${conversation.executionStatus} in ('pending', 'running', 'paused') then 'active'
    when ${conversation.stoppedAt} is not null then 'stopped'
    when ${conversation.executionStatus} = 'failed' or ${conversation.failedTurnId} is not null then 'failed'
    when ${needsInput} then 'needs_input'
    else 'idle'
  end`;
}
