import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * Raw web link matches of message events, one row for each match, written
 * with the event. Feed rows read a Conversation's newest links through the
 * primary key instead of scanning message text. Rows have no foreign key, so
 * that creating the table locks no existing table: transcript purge deletes
 * them with the events.
 */
export const juniorConversationLinks = pgTable(
  "junior_conversation_links",
  {
    conversationId: text("conversation_id").notNull(),
    /** `seq` of the message event. */
    seq: integer("seq").notNull(),
    /** Order of the match in the message text, from 1. */
    position: integer("position").notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_links_pk",
      columns: [table.conversationId, table.seq, table.position],
    }),
  ],
);
