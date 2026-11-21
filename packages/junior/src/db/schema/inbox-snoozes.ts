import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { EventMatch } from "@sentry/junior-plugin-api";
import { juniorInboxItems } from "./inbox-items";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * One person's snooze of one Inbox item. A `snoozed` row hides the item
 * from that person's Inbox until one of its triggers fires. `woken` and
 * `cancelled` are final. The item's own status says whether it resolved.
 */
export const juniorInboxSnoozes = pgTable(
  "junior_inbox_snoozes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
    inboxItemId: text("inbox_item_id")
      .notNull()
      .references(() => juniorInboxItems.id, { onDelete: "cascade" }),
    state: text("state").$type<"snoozed" | "woken" | "cancelled">().notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "junior_inbox_snoozes_state_check",
      sql`${table.state} in ('snoozed', 'woken', 'cancelled')`,
    ),
    // One snooze per person and item. It also serves the person's reads.
    uniqueIndex("junior_inbox_snoozes_snoozed_uidx")
      .on(table.userId, table.inboxItemId)
      .where(sql`${table.state} = 'snoozed'`),
    index("junior_inbox_snoozes_settled_idx")
      .on(table.createdAt)
      .where(sql`${table.state} <> 'snoozed'`),
    index("junior_inbox_snoozes_inbox_item_idx").on(table.inboxItemId),
  ],
);

/**
 * An Event that ends a snooze. `wake` brings the item back; `resolve`
 * dismisses the item and cancels the snooze. A snooze's triggers join with
 * OR: the first to fire wins, and the snooze ignores the rest. Time is a
 * `timer.fired` Event like any other.
 */
export const juniorInboxSnoozeTriggers = pgTable(
  "junior_inbox_snooze_triggers",
  {
    snoozeId: text("snooze_id")
      .notNull()
      .references(() => juniorInboxSnoozes.id, { onDelete: "cascade" }),
    outcome: text("outcome").$type<"wake" | "resolve">().notNull(),
    namespace: text("namespace").notNull(),
    identifier: text("identifier").notNull(),
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

/**
 * One person's Dismiss of an Inbox item that other people share: an item
 * for Everyone, or for more than one assignee. It hides the item from that
 * person only, with no wake time. The item stays open for the others, and
 * an answer still closes it for everyone.
 */
export const juniorInboxHides = pgTable(
  "junior_inbox_hides",
  {
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
    inboxItemId: text("inbox_item_id")
      .notNull()
      .references(() => juniorInboxItems.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.inboxItemId] }),
    index("junior_inbox_hides_inbox_item_idx").on(table.inboxItemId),
  ],
);
