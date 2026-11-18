import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { EventMatch } from "@sentry/junior-plugin-api";
import { juniorConversations } from "./conversations";
import { juniorReviewItems } from "./review-items";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * One User's snooze of one Inbox row: the root Conversation, or one Review
 * item in it. An `active` snooze hides the row from that User until
 * `wake_at_ms`, or until one of its triggers fires. Each later status is
 * final, and `reason` says why it changed.
 */
export const juniorInboxSnoozes = pgTable(
  "junior_inbox_snoozes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    reviewItemId: text("review_item_id").references(
      () => juniorReviewItems.id,
      { onDelete: "cascade" },
    ),
    wakeAtMs: bigint("wake_at_ms", { mode: "number" }).notNull(),
    status: text("status")
      .$type<"active" | "woken" | "resolved" | "cancelled">()
      .notNull(),
    reason: text("reason"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "junior_inbox_snoozes_status_check",
      sql`${table.status} in ('active', 'woken', 'resolved', 'cancelled')`,
    ),
    // One active snooze per User and row. It also serves the User's reads.
    uniqueIndex("junior_inbox_snoozes_active_row_uidx")
      .on(
        table.userId,
        table.conversationId,
        sql`coalesce(${table.reviewItemId}, '')`,
      )
      .where(sql`${table.status} = 'active'`),
    index("junior_inbox_snoozes_due_idx")
      .on(table.wakeAtMs)
      .where(sql`${table.status} = 'active'`),
    index("junior_inbox_snoozes_settled_idx")
      .on(table.createdAt)
      .where(sql`${table.status} <> 'active'`),
    index("junior_inbox_snoozes_conversation_idx").on(table.conversationId),
    index("junior_inbox_snoozes_review_item_idx")
      .on(table.reviewItemId)
      .where(sql`${table.reviewItemId} is not null`),
  ],
);

/**
 * An Event that ends a snooze early. `wake` brings the row back; `resolve`
 * dismisses the item and cancels the snooze. The first trigger to fire
 * wins, and a snooze that is no longer active ignores the rest.
 */
export const juniorInboxSnoozeTriggers = pgTable(
  "junior_inbox_snooze_triggers",
  {
    snoozeId: text("snooze_id")
      .notNull()
      .references(() => juniorInboxSnoozes.id, { onDelete: "cascade" }),
    outcome: text("outcome").$type<"wake" | "resolve">().notNull(),
    namespace: text("namespace").notNull(),
    identifier: text("identifier"),
    eventType: text("event_type").notNull(),
    match: jsonb("match").$type<EventMatch>(),
  },
  (table) => [
    check(
      "junior_inbox_snooze_triggers_outcome_check",
      sql`${table.outcome} in ('wake', 'resolve')`,
    ),
    index("junior_inbox_snooze_triggers_event_idx").on(
      table.namespace,
      table.identifier,
      table.eventType,
    ),
    index("junior_inbox_snooze_triggers_snooze_idx").on(table.snoozeId),
  ],
);
