import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import { conversationKindFromRow } from "./sql/conversation-row";
import type { ConversationKind } from "./store";

/** One Conversation in a parent chain. */
export interface ConversationLineageEntry {
  conversationId: string;
  kind: ConversationKind;
  parentConversationId?: string;
}

/**
 * Read the parent chain of a Conversation in one query, root first, with the
 * Conversation last. Returns an empty list when the Conversation is missing.
 *
 * The chain stops at a parent that is missing or that is already in the
 * chain. Then the first entry still has a `parentConversationId`, so callers
 * can tell a broken chain from one that ends at a root.
 */
export async function readConversationLineage(
  conversationId: string,
): Promise<ConversationLineageEntry[]> {
  // The path stops the walk at the first repeated id, so a bad parent link
  // cannot loop forever.
  const lineage = sql`(
    with recursive lineage(conversation_id, parent_conversation_id, depth, path) as (
      select selected.conversation_id, selected.parent_conversation_id, 0, array[selected.conversation_id]
      from junior_conversations selected
      where selected.conversation_id = ${conversationId}
      union all
      select parent.conversation_id, parent.parent_conversation_id, lineage.depth + 1, lineage.path || parent.conversation_id
      from junior_conversations parent
      join lineage on parent.conversation_id = lineage.parent_conversation_id
      where parent.conversation_id <> all(lineage.path)
    )
    select conversation_id, depth from lineage
  ) conversation_lineage`;
  const rows = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
    })
    .from(juniorConversations)
    .innerJoin(
      lineage,
      eq(
        sql`conversation_lineage.conversation_id`,
        juniorConversations.conversationId,
      ),
    )
    .orderBy(desc(sql`conversation_lineage.depth`));
  return rows.map((row) => ({
    conversationId: row.conversationId,
    kind: conversationKindFromRow(row),
    ...(row.parentConversationId
      ? { parentConversationId: row.parentConversationId }
      : undefined),
  }));
}
