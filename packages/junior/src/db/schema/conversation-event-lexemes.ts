import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversationEvents } from "./conversation-events";
import { timestamptz } from "./timestamps";
import { tsvector } from "./tsvector";

/**
 * Stored full-text lexemes of one searchable Conversation event, for keyword
 * search of the history of one Conversation. A derived index: a purge that
 * deletes the event deletes its row. Events are immutable, so a row never
 * changes.
 */
export const juniorConversationEventLexemes = pgTable(
  "junior_conversation_event_lexemes",
  {
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    lexemes: tsvector("lexemes").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_event_lexemes_pk",
      columns: [table.conversationId, table.seq],
    }),
    foreignKey({
      name: "junior_conversation_event_lexemes_event_fk",
      columns: [table.conversationId, table.seq],
      foreignColumns: [
        juniorConversationEvents.conversationId,
        juniorConversationEvents.seq,
      ],
    }).onDelete("cascade"),
    // A rare word, such as an id or a path, finds its events without a scan
    // of every stored row of the Conversation.
    index("junior_conversation_event_lexemes_lexemes_idx").using(
      "gin",
      table.lexemes,
    ),
  ],
);
