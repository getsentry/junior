import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import type { ConversationFeedViewerAnswer } from "@/api/schema/conversation-feed";
import { inboxItemOwnerConversationId } from "@/chat/inbox-items/owner";
import type { InboxItemRequest } from "@/chat/inbox-items/request";
import {
  inboxItemAnswer,
  inboxItemAnsweredAt,
  inboxItemAnsweredByUserId,
  inboxItemRequest,
  itemQuestion,
} from "@/chat/inbox-items/question-content";
import {
  answeredChoices,
  type UserInputAnswer,
} from "@/chat/inbox-items/user-input-request";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorInboxItems,
  juniorQuestions,
} from "@/db/schema";

type StoredViewerAnswer = {
  answer: UserInputAnswer;
  closedAt: string;
  request: InboxItemRequest;
};

/**
 * A feed row column with the viewer's newest answered Inbox item of its
 * Conversation, or null. It is a scalar subquery on the row read, so the
 * answer costs no round trip of its own, however many items the viewer
 * closed since.
 */
export function feedViewerAnswerSql(
  db: JuniorDatabase,
  userId: string,
): SQL<StoredViewerAnswer | null> {
  // No index holds an item's owner. The map of the viewer's newest answer
  // by owner has no outer reference, so Postgres builds it once for the
  // statement, not once for each feed row.
  const answered = db
    .select({
      answer:
        sql`jsonb_build_object('answer', ${inboxItemAnswer}, 'closedAt', ${inboxItemAnsweredAt}, 'request', ${inboxItemRequest})`.as(
          "answer",
        ),
      closedAt: inboxItemAnsweredAt.as("closed_at"),
      id: juniorInboxItems.id,
      ownerId: inboxItemOwnerConversationId().as("owner_id"),
    })
    .from(juniorInboxItems)
    .leftJoin(juniorQuestions, itemQuestion)
    .where(
      and(
        eq(inboxItemAnsweredByUserId, userId),
        isNotNull(inboxItemAnswer),
        isNotNull(inboxItemRequest),
      ),
    )
    .as("viewer_answered");
  const answers = db
    .selectDistinctOn([answered.ownerId], {
      answer: answered.answer,
      ownerId: answered.ownerId,
    })
    .from(answered)
    .where(isNotNull(answered.ownerId))
    .orderBy(answered.ownerId, desc(answered.closedAt), desc(answered.id))
    .as("viewer_answers");
  return sql<StoredViewerAnswer | null>`((select jsonb_object_agg(${answers.ownerId}, ${answers.answer}) from ${answers}) -> ${juniorConversations.conversationId})`;
}

/**
 * Keep only what a row says about the answer: when it closed and the
 * options that the viewer picked. Text answers have no choices.
 */
export function feedViewerAnswer(
  stored: StoredViewerAnswer | null,
): ConversationFeedViewerAnswer | undefined {
  if (!stored) return undefined;
  return {
    choices: answeredChoices(stored.request, stored.answer),
    closedAt: new Date(stored.closedAt).toISOString(),
  };
}
