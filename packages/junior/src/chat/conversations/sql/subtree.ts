import { sql, type SQL } from "drizzle-orm";

/** Columns of the `conversation_subtree` table that `conversationSubtree` returns. */
export const conversationSubtreeColumns = {
  conversationId: sql<string>`conversation_subtree.conversation_id`,
  scopeConversationId: sql<string>`conversation_subtree.scope_conversation_id`,
} as const;

/**
 * Return a joinable `conversation_subtree` table. It maps each selected
 * Conversation to itself and to each descendant child Conversation at any
 * depth. Reports use it so that a total for a Conversation always includes the
 * work of all its child agents.
 *
 * A descendant must have the same root as the selected Conversation. Thus a
 * Conversation that has no valid root gets only its own work.
 */
export function conversationSubtree(conversationIds: readonly string[]): SQL {
  const selectedIds = sql.join(
    conversationIds.map((conversationId) => sql`${conversationId}`),
    sql`, `,
  );
  // UNION, not UNION ALL, so that bad parent links cannot loop forever.
  return sql`(
    with recursive tree(scope_conversation_id, conversation_id, root_conversation_id) as (
      select selected.conversation_id, selected.conversation_id, selected.root_conversation_id
      from junior_conversations selected
      where selected.conversation_id in (${selectedIds})
      union
      select tree.scope_conversation_id, child.conversation_id, child.root_conversation_id
      from junior_conversations child
      join tree
        on child.parent_conversation_id = tree.conversation_id
        and child.root_conversation_id = tree.root_conversation_id
    )
    select scope_conversation_id, conversation_id from tree
  ) conversation_subtree`;
}
