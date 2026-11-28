import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  type AnyPgColumn,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  InboxItemNoticeRequest,
  InboxItemRequest,
} from "@/chat/inbox-items/request";
import type { UserInputAnswer } from "@/chat/inbox-items/user-input-request";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * The words of an Inbox item for search: its title, ranked above its body.
 * The `simple` config keeps each word as typed, so a prefix of it matches.
 */
export function inboxItemSearchDocument(table: {
  body: AnyPgColumn;
  title: AnyPgColumn;
}): SQL {
  return sql`(setweight(to_tsvector('simple', ${table.title}), 'A') || setweight(to_tsvector('simple', ${table.body}), 'B'))`;
}

/** The lowercase title of an Inbox item, for typo-tolerant search. */
export function inboxItemFuzzyTitle(table: { title: AnyPgColumn }): SQL {
  return sql`lower(${table.title})`;
}

/**
 * One Inbox item: something that needs a person. An action item stores its
 * `request`, and
 * its `answer` after an assignee submits it. `closed_at` is set for `done`
 * and `dismissed`. `closed_by_user_id` is null when an agent closed it.
 *
 * `subject_kind` and `subject_id` name what the item is about. The kind
 * says what the item asks. A plugin kind starts with the plugin name, such
 * as `github:pull_request_review`. Junior reads the subject's title, state,
 * and link from the subject when it shows the item, and never copies them
 * into a column here. `inbox-item-fields:check` keeps it that way. The
 * subject also names the item's owner, which sets who can see it, so the
 * item stores no owner (`chat/inbox-items/owner.ts`).
 */
export const juniorInboxItems = pgTable(
  "junior_inbox_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"notice" | "action">().notNull(),
    status: text("status").$type<"open" | "done" | "dismissed">().notNull(),
    /**
     * A `question` item's question holds its title, body, request, and
     * answer (`junior_questions`). The item keeps a copy of the title,
     * body, and request for the release before this one, and new code
     * never reads it.
     */
    title: text("title"),
    body: text("body"),
    request: jsonb("request").$type<
      InboxItemRequest | InboxItemNoticeRequest
    >(),
    answer: jsonb("answer").$type<UserInputAnswer>(),
    assignedToEveryone: boolean("assigned_to_everyone")
      .notNull()
      .default(false),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    /**
     * Turn of the agent that added the item, or that last added it again with
     * its subject. Null for a plugin item, which has no Turn.
     */
    addedByTurnId: text("added_by_turn_id"),
    closedAt: timestamptz("closed_at"),
    closedByUserId: text("closed_by_user_id").references(() => juniorUsers.id, {
      onDelete: "set null",
    }),
    closeReason: text("close_reason"),
    /**
     * The id of the subject kind's action that a person ran to close it,
     * such as `resume` (`PluginInboxSubjectKind.actions`).
     */
    closeAction: text("close_action"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    // A notice asks nothing. An action asks with its form, or for a step
    // outside the card, such as a merge, a To-do, or a fix to an
    // Automation, and the code that added it closes it. A question item
    // stores neither: its question holds its form and its answer.
    check(
      "junior_inbox_items_kind_check",
      sql`(${table.kind} = 'notice' and ${table.request} -> 'question' is null and ${table.answer} is null) or (${table.kind} = 'action' and (${table.request} -> 'question' is not null or (${table.subjectKind} <> 'reply' and ${table.answer} is null)))`,
    ),
    check(
      "junior_inbox_items_status_check",
      sql`(${table.status} = 'open' and ${table.closedAt} is null) or (${table.status} in ('done', 'dismissed') and ${table.closedAt} is not null)`,
    ),
    // The subject names one open item: an add with the subject of an open
    // item adds nothing.
    uniqueIndex("junior_inbox_items_open_subject_key_uidx")
      .on(table.subjectKind, table.subjectId)
      .where(sql`${table.status} = 'open'`),
    index("junior_inbox_items_status_idx").on(
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("junior_inbox_items_subject_idx").on(table.subjectId, table.status),
    // Reads find the open items of one kind, such as the To-dos.
    index("junior_inbox_items_subject_kind_idx").on(
      table.subjectKind,
      table.status,
    ),
    index("junior_inbox_items_search_idx").using(
      "gin",
      inboxItemSearchDocument(table),
    ),
    index("junior_inbox_items_title_trgm_idx").using(
      "gin",
      sql`${inboxItemFuzzyTitle(table)} gin_trgm_ops`,
    ),
  ],
);

/** The assigned Users of an Inbox item. Everyone is a flag on the item. */
export const juniorInboxItemAssignees = pgTable(
  "junior_inbox_item_assignees",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => juniorInboxItems.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.userId] }),
    index("junior_inbox_item_assignees_user_idx").on(table.userId),
  ],
);

/** The Conversations linked to an Inbox item. */
export const juniorInboxItemConversations = pgTable(
  "junior_inbox_item_conversations",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => juniorInboxItems.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.conversationId] }),
    index("junior_inbox_item_conversations_conversation_idx").on(
      table.conversationId,
    ),
  ],
);

/**
 * The Slack message that shows an Inbox item in one linked Slack thread.
 * Junior updates it in place after each change.
 */
export const juniorInboxItemSlackCards = pgTable(
  "junior_inbox_item_slack_cards",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => juniorInboxItems.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageTs: text("message_ts").notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.conversationId] })],
);

/**
 * One notification of one Inbox item event to one assigned User on one
 * channel: a Slack card in a thread of the item, or a web push. The key stops a second send for the same event, also on a
 * retry. `skip_reason` says why a `skipped` row sent nothing. A `sent` row
 * becomes `cleared` when the item closes, so the devices can close it.
 */
export const juniorInboxItemDeliveries = pgTable(
  "junior_inbox_item_deliveries",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => juniorInboxItems.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
    channel: text("channel").$type<"slack" | "web_push">().notNull(),
    event: text("event").$type<"created" | "reply" | "wake">().notNull(),
    status: text("status").$type<"sent" | "skipped" | "cleared">().notNull(),
    skipReason: text("skip_reason"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.userId, table.channel, table.event],
    }),
    index("junior_inbox_item_deliveries_user_status_idx").on(
      table.userId,
      table.status,
      table.updatedAt,
    ),
  ],
);
