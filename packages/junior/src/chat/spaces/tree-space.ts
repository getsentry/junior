import {
  and,
  eq,
  getTableName,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";

/**
 * SQL for the Space of a Conversation (`design/spaces.md`). Only a Lead
 * stores its Space. Every Conversation in a Space has the Lead as its tree
 * root, so it reads the Space of its root.
 */
export function rootSpaceIdSql(
  conversation: PgTable & {
    rootConversationId: AnyPgColumn;
    spaceId: AnyPgColumn;
  },
): SQL<string | null> {
  // A single-table select writes its fields without the table name, and an
  // unqualified root id would read the subquery's own row. Name the table.
  const outerRoot = sql`${sql.identifier(getTableName(conversation))}.${sql.identifier(conversation.rootConversationId.name)}`;
  return sql<string | null>`coalesce(${conversation.spaceId}, (
    select space_lead.space_id
    from junior_conversations space_lead
    where space_lead.conversation_id = ${outerRoot}
  ))`;
}

const spaceLead = alias(juniorConversations, "space_lead_ids");

/** The ids of a Space's Lead, as a subquery. Its children are the Space's top-level Conversations. */
export function spaceLeadIds(spaceId: string) {
  return getDb()
    .select({ id: spaceLead.conversationId })
    .from(spaceLead)
    .where(and(eq(spaceLead.spaceId, spaceId), eq(spaceLead.kind, "lead")));
}

/** True when the Conversation with this id is a Lead. */
export function isLeadSql(conversationId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from junior_conversations lead_parent
    where lead_parent.conversation_id = ${conversationId}
      and lead_parent.kind = 'lead'
  )`;
}
