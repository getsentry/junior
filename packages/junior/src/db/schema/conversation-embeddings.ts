import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversationBriefs } from "./conversation-briefs";
import { timestamptz } from "./timestamps";

/**
 * pgvector column without a fixed size, so a change of embedding model needs
 * no migration. The dimensions column records the size of each row.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value.slice(1, -1).split(",").map(Number);
  },
});

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
    embedding: vector("embedding").notNull(),
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
