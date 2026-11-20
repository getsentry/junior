import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import type { ConversationFeedViewerAnswer } from "@/api/schema/conversation-feed";
import type { ReviewItemRequest } from "@/chat/review-items/evidence";
import {
  answeredChoices,
  type UserInputAnswer,
} from "@/chat/tools/runtime/user-input-request";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations, juniorReviewItems } from "@/db/schema";

type StoredViewerAnswer = {
  answer: UserInputAnswer;
  closedAt: string;
  request: ReviewItemRequest;
};

/**
 * A feed row column with the viewer's newest answered Review item of its
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
      answer: sql`jsonb_build_object('answer', ${juniorReviewItems.answer}, 'closedAt', ${juniorReviewItems.closedAt}, 'request', ${juniorReviewItems.request})`,
    })
    .from(juniorReviewItems)
    .where(
      and(
        eq(
          juniorReviewItems.addedByConversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorReviewItems.closedByUserId, userId),
        isNotNull(juniorReviewItems.answer),
        isNotNull(juniorReviewItems.request),
      ),
    )
    .orderBy(desc(juniorReviewItems.closedAt), desc(juniorReviewItems.id))
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
