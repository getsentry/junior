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
 * A descendant must have the same top-level Conversation as the selected
 * one. Thus a Conversation that has none gets only its own work. A selected
 * top-level Conversation gets every Conversation that stores it as theirs.
 */
export function conversationSubtree(conversationIds: readonly string[]): SQL {
  const selectedIds = sql.join(
    conversationIds.map((conversationId) => sql`${conversationId}`),
    sql`, `,
  );
  // A top-level Conversation finds its work with
  // `junior_conversations_top_level_idx`, in one lookup. Only a child walks
  // down by parent, since its work is part of a larger one. The walk starts
  // from the selected children only, and reads only the work of their
  // top-level Conversations, which that index finds.
  // Postgres guesses each recursive step at hundreds of rows, so a step that
  // reads `junior_conversations` itself hashes the whole table on every
  // poll. A materialized set of tree members keeps the step that small.
  // UNION, not UNION ALL, so that bad parent links cannot loop forever, and
  // so a root shows once in its own tree.
  return sql`(
    with recursive tree_member as materialized (
      select member.conversation_id, member.parent_conversation_id, member.top_level_conversation_id
      from junior_conversations member
      where member.top_level_conversation_id in (
        select selected.top_level_conversation_id
        from junior_conversations selected
        where selected.conversation_id in (${selectedIds})
          and selected.top_level_conversation_id is distinct from selected.conversation_id
      )
    ),
    walk(scope_conversation_id, conversation_id, top_level_conversation_id) as (
      select selected.conversation_id, selected.conversation_id, selected.top_level_conversation_id
      from junior_conversations selected
      where selected.conversation_id in (${selectedIds})
        and selected.top_level_conversation_id is distinct from selected.conversation_id
      union
      select walk.scope_conversation_id, child.conversation_id, child.top_level_conversation_id
      from tree_member child
      join walk
        on child.parent_conversation_id = walk.conversation_id
        and child.top_level_conversation_id = walk.top_level_conversation_id
    )
    select selected.conversation_id as scope_conversation_id, selected.conversation_id
    from junior_conversations selected
    where selected.conversation_id in (${selectedIds})
    union
    select selected.conversation_id, member.conversation_id
    from junior_conversations selected
    join junior_conversations member
      on member.top_level_conversation_id = selected.conversation_id
    where selected.conversation_id in (${selectedIds})
      and selected.top_level_conversation_id = selected.conversation_id
    union
    select scope_conversation_id, conversation_id from walk
  ) conversation_subtree`;
}
