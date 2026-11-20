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
 * Conversation that has no valid root gets only its own work. A selected root
 * gets every Conversation that stores it as their root.
 */
export function conversationSubtree(conversationIds: readonly string[]): SQL {
  const selectedIds = sql.join(
    conversationIds.map((conversationId) => sql`${conversationId}`),
    sql`, `,
  );
  // A root finds its tree with `junior_conversations_root_idx`, in one
  // lookup. Only a child walks down by parent, since its tree is part of a
  // larger one. `walks` marks the rows that the recursive step expands.
  // UNION, not UNION ALL, so that bad parent links cannot loop forever.
  // `|| ''` keeps the root check out of the index condition, so Postgres
  // finds the children of each Conversation by parent. With a plain `=` it
  // can look them up by root instead, which reads the whole tree for each
  // Conversation in it. `|| ''` keeps null as null, so the check is the same.
  return sql`(
    with recursive tree(scope_conversation_id, conversation_id, root_conversation_id, walks) as (
      select
        selected.conversation_id,
        selected.conversation_id,
        selected.root_conversation_id,
        selected.root_conversation_id is distinct from selected.conversation_id
      from junior_conversations selected
      where selected.conversation_id in (${selectedIds})
      union
      select selected.conversation_id, member.conversation_id, member.root_conversation_id, false
      from junior_conversations selected
      join junior_conversations member
        on member.root_conversation_id = selected.conversation_id
      where selected.conversation_id in (${selectedIds})
        and selected.root_conversation_id = selected.conversation_id
      union
      select tree.scope_conversation_id, child.conversation_id, child.root_conversation_id, true
      from junior_conversations child
      join tree
        on child.parent_conversation_id = tree.conversation_id
        and (child.root_conversation_id || '') = tree.root_conversation_id
      where tree.walks
    )
    select scope_conversation_id, conversation_id from tree
  ) conversation_subtree`;
}
