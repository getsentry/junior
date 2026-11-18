import { inArray, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";

/** SQL that advances `detail_version` inside a `juniorConversations` set. */
export const nextDetailVersion = sql`${juniorConversations.detailVersion} + 1`;

function bumpDetailVersion(
  db: JuniorDatabase,
  conversationIds: readonly string[],
) {
  return db
    .update(juniorConversations)
    .set({ detailVersion: nextDetailVersion })
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));
}

/**
 * Return a CTE that marks the detail report of each Conversation as changed,
 * in the same statement as the write that it covers:
 * `db.with(conversationDetailTouch(db, ids)).insert(table)`.
 * Postgres runs a data-modifying CTE even when the statement does not read it,
 * and both changes commit together.
 */
export function conversationDetailTouch(
  db: JuniorDatabase,
  conversationIds: readonly string[],
) {
  return db.$with("conversation_detail_touch").as(
    bumpDetailVersion(db, conversationIds).returning({
      conversationId: juniorConversations.conversationId,
    }),
  );
}

/**
 * Mark the detail report of each Conversation as changed, for a write that
 * cannot carry `conversationDetailTouch`. Call it after that write, in the same
 * transaction when there is one. A bump before the write lets a detail read
 * store old content under the new version.
 */
export async function touchConversationDetail(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<void> {
  if (conversationIds.length === 0) return;
  await bumpDetailVersion(db, conversationIds);
}
