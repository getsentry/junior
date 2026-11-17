import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversationEvents } from "./conversation-events";
import { timestamptz } from "./timestamps";
import { embeddingHalfvec } from "@sentry/junior-plugin-api/embeddings";

/**
 * One embedding per searchable Conversation event, for semantic search of the
 * history of one Conversation. A derived index: a purge that deletes the
 * event deletes its row, and a new embedding model replaces the row.
 */
export const juniorConversationEventEmbeddings = pgTable(
  "junior_conversation_event_embeddings",
  {
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    // Half precision keeps the ranking and halves the size of the table. The
    // migration also sets STORAGE MAIN, so a vector stays in its row and the
    // exact scan of a Conversation reads no TOAST.
    embedding: embeddingHalfvec("embedding").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_event_embeddings_pk",
      columns: [table.conversationId, table.seq],
    }),
    foreignKey({
      name: "junior_conversation_event_embeddings_event_fk",
      columns: [table.conversationId, table.seq],
      foreignColumns: [
        juniorConversationEvents.conversationId,
        juniorConversationEvents.seq,
      ],
    }).onDelete("cascade"),
    check(
      "junior_conversation_event_embeddings_dimensions_check",
      sql`vector_dims(${table.embedding}) = ${table.dimensions}`,
    ),
  ],
);
