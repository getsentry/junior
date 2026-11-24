import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import type { ConversationFeedViewerAnswer } from "@/api/schema/conversation-feed";
import { inboxItemOwnedByConversation } from "@/chat/inbox-items/access";
import type { InboxItemRequest } from "@/chat/inbox-items/evidence";
import {
  answeredChoices,
  type UserInputAnswer,
} from "@/chat/inbox-items/user-input-request";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations, juniorInboxItems } from "@/db/schema";

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
  const latest = db
    .select({
      answer: sql`jsonb_build_object('answer', ${juniorInboxItems.answer}, 'closedAt', ${juniorInboxItems.closedAt}, 'request', ${juniorInboxItems.request})`,
    })
    .from(juniorInboxItems)
    .where(
      and(
        inboxItemOwnedByConversation(juniorConversations.conversationId),
        eq(juniorInboxItems.closedByUserId, userId),
        isNotNull(juniorInboxItems.answer),
        isNotNull(juniorInboxItems.request),
      ),
    )
    .orderBy(desc(juniorInboxItems.closedAt), desc(juniorInboxItems.id))
    .limit(1);
  return sql<StoredViewerAnswer | null>`(${latest})`;
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
