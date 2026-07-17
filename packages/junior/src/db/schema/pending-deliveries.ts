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
  PendingConversationDeliveryProgress,
} from "@/chat/slack/delivery-command";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/** Mutable, deletable control state for unresolved external deliveries. */
export const juniorPendingDeliveries = pgTable(
  "junior_pending_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id").notNull(),
    command: jsonb("command_json")
      .$type<PendingConversationDeliveryCommand>()
      .notNull(),
    progress: jsonb("progress_json")
      .$type<PendingConversationDeliveryProgress>()
      .notNull(),
    nextAttemptAt: timestamptz("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseVersion: integer("lease_version").default(0).notNull(),
    leaseExpiresAt: timestamptz("lease_expires_at"),
  },
  (table) => [
    foreignKey({
      name: "junior_pending_deliveries_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    uniqueIndex("junior_pending_deliveries_conversation_idx").on(
      table.conversationId,
    ),
    index("junior_pending_deliveries_due_idx").on(table.nextAttemptAt),
    check(
      "junior_pending_deliveries_lease_version_check",
      sql`${table.leaseVersion} >= 0`,
    ),
  ],
);
