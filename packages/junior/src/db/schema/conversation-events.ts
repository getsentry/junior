import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/**
 * Append-only canonical conversation history. `context_epoch` partitions the
 * log into rebuild generations, while `(conversation_id, seq)` is the stable
 * event identity and lease-fencing tripwire.
 */
export const juniorConversationEvents = pgTable(
  "junior_conversation_events",
  {
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    contextEpoch: integer("context_epoch").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    idempotencyKey: text("idempotency_key"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_events_conversation_id_seq_pk",
      columns: [table.conversationId, table.seq],
    }),
    foreignKey({
      name: "junior_conversation_events_conversation_id_junior_conversations_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }),
    index("junior_conversation_events_epoch_idx").on(
      table.conversationId,
      table.contextEpoch,
      table.seq,
    ),
    index("junior_conversation_events_type_idx").on(
      table.conversationId,
      table.type,
      table.seq,
    ),
    uniqueIndex("junior_conversation_events_idempotency_idx").on(
      table.conversationId,
      table.idempotencyKey,
    ),
  ],
);
