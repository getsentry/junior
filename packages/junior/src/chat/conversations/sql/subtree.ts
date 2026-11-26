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
  // larger one. The walk starts from the selected children only, and reads
  // only the members of their roots' trees, which the root index finds.
  // Postgres guesses each recursive step at hundreds of rows, so a step that
  // reads `junior_conversations` itself hashes the whole table on every
  // poll. A materialized set of tree members keeps the step that small.
  // UNION, not UNION ALL, so that bad parent links cannot loop forever, and
  // so a root shows once in its own tree.
  return sql`(
    with recursive tree_member as materialized (
      select member.conversation_id, member.parent_conversation_id, member.root_conversation_id
      from junior_conversations member
      where member.root_conversation_id in (
        select selected.root_conversation_id
        from junior_conversations selected
        where selected.conversation_id in (${selectedIds})
          and selected.root_conversation_id is distinct from selected.conversation_id
      )
    ),
    walk(scope_conversation_id, conversation_id, root_conversation_id) as (
      select selected.conversation_id, selected.conversation_id, selected.root_conversation_id
      from junior_conversations selected
      where selected.conversation_id in (${selectedIds})
        and selected.root_conversation_id is distinct from selected.conversation_id
      union
      select walk.scope_conversation_id, child.conversation_id, child.root_conversation_id
      from tree_member child
      join walk
        on child.parent_conversation_id = walk.conversation_id
        and child.root_conversation_id = walk.root_conversation_id
    )
    select selected.conversation_id as scope_conversation_id, selected.conversation_id
    from junior_conversations selected
    where selected.conversation_id in (${selectedIds})
    union
    select selected.conversation_id, member.conversation_id
    from junior_conversations selected
    join junior_conversations member
      on member.root_conversation_id = selected.conversation_id
    where selected.conversation_id in (${selectedIds})
      and selected.root_conversation_id = selected.conversation_id
    union
    select scope_conversation_id, conversation_id from walk
  ) conversation_subtree`;
}

/**
 * Return a subquery of the given Conversations and each of their ancestors.
 * A list filter keeps the row that matches its own rules, so a match deep
 * in a tree finds its top-level Conversation, such as a Lead's child.
 */
export function conversationAncestorsOrSelf(selectedIds: SQL): SQL {
  // UNION, not UNION ALL, so that bad parent links cannot loop forever.
  return sql`(
    with recursive ancestor(conversation_id, parent_conversation_id) as (
      select selected.conversation_id, selected.parent_conversation_id
      from junior_conversations selected
      where selected.conversation_id in (${selectedIds})
      union
      select parent.conversation_id, parent.parent_conversation_id
      from junior_conversations parent
      join ancestor on parent.conversation_id = ancestor.parent_conversation_id
    )
    select conversation_id from ancestor
  )`;
}
