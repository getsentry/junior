import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  CONVERSATION_FEED_MEDIA_LIMIT,
  type ConversationFeedMedia,
} from "@/api/schema/conversation-feed";
import type { JuniorDatabase } from "@/db/db";
import { juniorAttachments, juniorConversations } from "@/db/schema";

/**
 * Read the newest stored files of each Conversation for its feed row, in one
 * query with a lateral subquery per row. Pass only the Conversations whose
 * private content the viewer can see. Only file metadata leaves the
 * database.
 */
export async function readFeedMedia(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationFeedMedia[]>> {
  const media = new Map<string, ConversationFeedMedia[]>();
  if (conversationIds.length === 0) return media;

  const recentFiles = db
    .select({
      contentType: juniorAttachments.contentType,
      createdAt: juniorAttachments.createdAt,
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
    })
    .from(juniorAttachments)
    .where(
      and(
        eq(
          juniorAttachments.conversationId,
          juniorConversations.conversationId,
        ),
        // Only a stored file has a storage provider. Rows for web links
        // will share this table, and a worker that runs during their deploy
        // must not list them as files.
        isNotNull(juniorAttachments.storageProvider),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    )
    .orderBy(desc(juniorAttachments.createdAt), desc(juniorAttachments.id))
    .limit(CONVERSATION_FEED_MEDIA_LIMIT)
    .as("recent_files");
  const files = db
    .select({
      files: sql<
        ConversationFeedMedia[] | null
      >`jsonb_agg(jsonb_build_object('contentType', ${recentFiles.contentType}, 'filename', ${recentFiles.filename}, 'id', ${recentFiles.id}) order by ${recentFiles.createdAt} desc, ${recentFiles.id} desc)`.as(
        "files",
      ),
    })
    .from(recentFiles)
    .as("files");

  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      files: files.files,
    })
    .from(juniorConversations)
    .leftJoinLateral(files, sql`true`)
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));
  for (const { conversationId, files: rowFiles } of rows) {
    if (rowFiles?.length) media.set(conversationId, rowFiles);
  }
  return media;
}
