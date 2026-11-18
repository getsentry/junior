import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text } from "drizzle-orm/pg-core";
import { juniorConversationBriefs } from "./conversation-briefs";
import { timestamptz } from "./timestamps";
import { embeddingVector } from "@sentry/junior-plugin-api/embeddings";

/**
 * One embedding per Conversation, for semantic search. Its text is the latest
 * Brief. A derived index: the next Brief replaces the row, and deleting that
 * Brief row deletes it.
 */
export const juniorConversationEmbeddings = pgTable(
  "junior_conversation_embeddings",
  {
    conversationId: text("conversation_id").primaryKey(),
    briefVersion: integer("brief_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    embedding: embeddingVector("embedding").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_conversation_embeddings_brief_fk",
      columns: [table.conversationId, table.briefVersion],
      foreignColumns: [
        juniorConversationBriefs.conversationId,
        juniorConversationBriefs.version,
      ],
    }).onDelete("cascade"),
    check(
      "junior_conversation_embeddings_dimensions_check",
      sql`vector_dims(${table.embedding}) = ${table.dimensions}`,
    ),
  ],
);
