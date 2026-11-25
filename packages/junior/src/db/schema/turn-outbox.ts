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
  uuid,
} from "drizzle-orm/pg-core";
import type { Destination } from "@sentry/junior-plugin-api";
import { juniorConversationEvents } from "./conversation-events";
import { timestamptz } from "./timestamps";
import { juniorTurns } from "./turns";

/**
 * One row per message to deliver to a Destination. The content stays in the
 * message event; the row only tracks delivery.
 */
export const juniorTurnOutbox = pgTable(
  "junior_turn_outbox",
  {
    id: uuid("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => juniorTurns.id),
    eventSeq: integer("event_seq").notNull(),
    // Where this message goes. A reply copies its Turn's Destination.
    destination: jsonb("destination").$type<Destination>().notNull(),
    state: text("state").$type<"pending" | "sent" | "failed">().notNull(),
    attempts: integer("attempts").default(0).notNull(),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    sentAt: timestamptz("sent_at"),
  },
  (table) => [
    // Retention purges events, which removes their delivery rows.
    foreignKey({
      name: "junior_turn_outbox_event_fk",
      columns: [table.conversationId, table.eventSeq],
      foreignColumns: [
        juniorConversationEvents.conversationId,
        juniorConversationEvents.seq,
      ],
    }).onDelete("cascade"),
    check(
      "junior_turn_outbox_state_check",
      sql`${table.state} in ('pending', 'sent', 'failed')`,
    ),
    check(
      "junior_turn_outbox_sent_check",
      sql`(${table.state} = 'sent') = (${table.sentAt} is not null)`,
    ),
    check("junior_turn_outbox_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "junior_turn_outbox_destination_check",
      sql`jsonb_typeof(${table.destination}) = 'object'`,
    ),
    uniqueIndex("junior_turn_outbox_event_idx").on(
      table.conversationId,
      table.eventSeq,
    ),
    // Sweeper: rows whose queue message was lost.
    index("junior_turn_outbox_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'pending'`),
  ],
);
