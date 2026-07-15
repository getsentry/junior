import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PendingConversationDeliveryCommand,
  PendingConversationDeliveryPartState,
} from "@/chat/conversations/delivery";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/** Mutable, deletable control state for unresolved external deliveries. */
export const juniorPendingDeliveries = pgTable(
  "junior_pending_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id").notNull(),
    messageId: text("message_id").notNull(),
    provider: text("provider").notNull(),
    deliveryKind: text("delivery_kind").notNull(),
    command: jsonb("command_json")
      .$type<PendingConversationDeliveryCommand>()
      .notNull(),
    partStates: jsonb("part_states_json")
      .$type<Record<string, PendingConversationDeliveryPartState>>()
      .notNull(),
    nextPartIndex: integer("next_part_index").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamptz("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseVersion: integer("lease_version").default(0).notNull(),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    lastAttemptAt: timestamptz("last_attempt_at"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_pending_deliveries_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    uniqueIndex("junior_pending_deliveries_conversation_turn_idx").on(
      table.conversationId,
      table.turnId,
    ),
    index("junior_pending_deliveries_retry_idx").on(
      table.nextAttemptAt,
      table.deliveryId,
    ),
    check(
      "junior_pending_deliveries_cursor_check",
      sql`${table.nextPartIndex} >= 0`,
    ),
    check(
      "junior_pending_deliveries_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "junior_pending_deliveries_lease_version_check",
      sql`${table.leaseVersion} >= 0`,
    ),
  ],
);
