import { and, desc, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  CONVERSATION_FEED_MEDIA_LIMIT,
  type ConversationFeedMedia,
} from "@/api/schema/conversation-feed";
import type { JuniorDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";

/**
 * Read the newest stored files of each Conversation for its feed row, in one
 * query. Pass only the Conversations whose private content the viewer can
 * see: files are private content.
 */
export async function readFeedMedia(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationFeedMedia[]>> {
  const media = new Map<string, ConversationFeedMedia[]>();
  if (conversationIds.length === 0) return media;
  const ranked = db
    .select({
      contentType: juniorAttachments.contentType,
      conversationId: juniorAttachments.conversationId,
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
      rank: sql<number>`row_number() over (partition by ${juniorAttachments.conversationId} order by ${desc(juniorAttachments.createdAt)}, ${desc(juniorAttachments.id)})`.as(
        "rank",
      ),
    })
    .from(juniorAttachments)
    .where(
      and(
        inArray(juniorAttachments.conversationId, [...conversationIds]),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    )
    .as("ranked");
  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rank, CONVERSATION_FEED_MEDIA_LIMIT))
    .orderBy(ranked.conversationId, ranked.rank);
  for (const { conversationId, contentType, filename, id } of rows) {
    const list = media.get(conversationId) ?? [];
    list.push({ contentType, filename, id });
    media.set(conversationId, list);
  }
  return media;
}
