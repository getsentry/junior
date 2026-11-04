import { inArray, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";

/** SQL that advances `detail_version` inside a `juniorConversations` set. */
export const nextDetailVersion = sql`${juniorConversations.detailVersion} + 1`;

/**
 * Mark the detail report of each Conversation as changed. Call it after the
 * write it covers, in the same transaction when there is one. A bump before
 * the write lets a detail read store old content under the new version.
 */
export async function touchConversationDetail(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(conversationIds)];
  if (ids.length === 0) return;
  await db
    .update(juniorConversations)
    .set({ detailVersion: nextDetailVersion })
    .where(inArray(juniorConversations.conversationId, ids));
}
