import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/**
 * Append-only durable execution history: one row per agent step. `context_epoch`
 * partitions the log into rebuild generations; the model context is the highest
 * epoch's `pi_message` rows in `seq` order. The `(conversation_id, seq)` primary
 * key doubles as the lease-fencing tripwire — a conflicting append fails loudly.
 */
export const juniorAgentSteps = pgTable(
  "junior_agent_steps",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    seq: integer("seq").notNull(),
    contextEpoch: integer("context_epoch").notNull(),
    type: text("type").notNull(),
    role: text("role"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.seq] }),
    index("junior_agent_steps_epoch_idx").on(
      table.conversationId,
      table.contextEpoch,
      table.seq,
    ),
  ],
);
