import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  CONVERSATION_FEED_MEDIA_LIMIT,
  type ConversationFeedMedia,
} from "@/api/schema/conversation-feed";
import type { JuniorDatabase } from "@/db/db";
import { isFileAttachment } from "@/chat/attachments/store";
import { juniorAttachments, juniorConversations } from "@/db/schema";

/**
 * A feed row column with the newest stored files of its Conversation, or
 * null when it has none. It is a scalar subquery on the row read, so media
 * costs no round trip of its own. Files are private content: show them
 * only where the viewer sees private content. Only file metadata leaves the
 * database.
 */
export function feedMediaSql(
  db: JuniorDatabase,
): SQL<ConversationFeedMedia[] | null> {
  const recentFiles = db
    .select({
      contentType: juniorAttachments.contentType,
      createdAt: juniorAttachments.createdAt,
      filename: juniorAttachments.title,
      id: juniorAttachments.id,
    })
    .from(juniorAttachments)
    .where(
      and(
        eq(
          juniorAttachments.conversationId,
          juniorConversations.conversationId,
        ),
        isFileAttachment,
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    )
    .orderBy(desc(juniorAttachments.createdAt), desc(juniorAttachments.id))
    .limit(CONVERSATION_FEED_MEDIA_LIMIT)
    .as("recent_files");
  const files = db
    .select({
      files: sql`jsonb_agg(jsonb_build_object('contentType', ${recentFiles.contentType}, 'filename', ${recentFiles.filename}, 'id', ${recentFiles.id}) order by ${recentFiles.createdAt} desc, ${recentFiles.id} desc)`,
    })
    .from(recentFiles);
  return sql<ConversationFeedMedia[] | null>`(${files})`;
}
