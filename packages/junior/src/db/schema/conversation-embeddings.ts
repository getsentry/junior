import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
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
 * One embedding per Conversation, for semantic search. Its text is the
 * Conversation metadata. A derived index: the next metadata update replaces
 * the row.
 */
export const juniorConversationEmbeddings = pgTable(
  "junior_conversation_embeddings",
  {
    conversationId: text("conversation_id").primaryKey(),
    // TODO(dcramer): Drop brief_version after no deployed worker writes it.
    legacyBriefVersion: integer("brief_version"),
    /** The `metadata_through_seq` of the embedded Conversation metadata. */
    throughSeq: integer("through_seq"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    embedding: vector("embedding").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_conversation_embeddings_conversation_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    check(
      "junior_conversation_embeddings_dimensions_check",
      sql`vector_dims(${table.embedding}) = ${table.dimensions}`,
    ),
  ],
);
