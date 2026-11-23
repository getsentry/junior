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
import type { InboxItemSubjectTitleParts } from "@sentry/junior-plugin-api";
import type { InboxItemRequest } from "@/chat/inbox-items/evidence";
import type { UserInputAnswer } from "@/chat/inbox-items/user-input-request";
import { juniorAutomations } from "./automations";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * What an Inbox item belongs to: the Conversation of the agent or plugin
 * that added it, or the Automation of an Automation alert. A new kind adds
 * a value here and to the owner check.
 */
export type InboxItemOwnerKind = "conversation" | "automation";

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
 * `owner_kind` and `owner_id` name its owner. The owner kind decides how the
 * item gets its visibility and tenant, and where the Inbox stacks it. The id
 * has no foreign key, because it can name a row of more than one table.
 */
export const juniorInboxItems = pgTable(
  "junior_inbox_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"notice" | "action">().notNull(),
    status: text("status").$type<"open" | "done" | "dismissed">().notNull(),
    /**
     * `private` when the Conversation that added it is not public. A private
     * item stays private and links only to that Conversation.
     */
    visibility: text("visibility").$type<"public" | "private">().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    request: jsonb("request").$type<InboxItemRequest>(),
    answer: jsonb("answer").$type<UserInputAnswer>(),
    assignedToEveryone: boolean("assigned_to_everyone")
      .notNull()
      .default(false),
    dedupeKey: text("dedupe_key").notNull(),
    subjectId: text("subject_id"),
    subjectTitle: text("subject_title"),
    subjectUrl: text("subject_url"),
    /** The parsed subject title of a code change (`InboxItemSubjectTitleParts`). */
    subjectTitleParts: jsonb(
      "subject_title_parts",
    ).$type<InboxItemSubjectTitleParts>(),
    // The default filled the rows from before owners had kinds.
    ownerKind: text("owner_kind")
      .$type<InboxItemOwnerKind>()
      .notNull()
      .default("conversation"),
    ownerId: text("owner_id").notNull(),
    /**
     * Turn of the agent that added the item, or that last added it again with
     * its dedupe key. Null for a plugin item, which has no Turn.
     */
    addedByTurnId: text("added_by_turn_id"),
    /**
     * Provider tenant, such as a Slack workspace, of the Conversation that
     * added the item. A public item is visible only inside it.
     */
    provider: text("provider"),
    providerTenantId: text("provider_tenant_id"),
    automationId: text("automation_id").references(() => juniorAutomations.id, {
      onDelete: "set null",
    }),
    closedAt: timestamptz("closed_at"),
    closedByUserId: text("closed_by_user_id").references(() => juniorUsers.id, {
      onDelete: "set null",
    }),
    closeReason: text("close_reason"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    // An agent's action asks a question. A plugin's action asks for a step
    // outside Junior, such as a merge, and the plugin closes it. An
    // Automation alert asks its creator to fix the Automation, and core
    // closes it when the Automation recovers.
    check(
      "junior_inbox_items_kind_check",
      sql`(${table.kind} = 'notice' and ${table.request} is null and ${table.answer} is null) or (${table.kind} = 'action' and (${table.request} is not null or ((${table.dedupeKey} like 'plugin:%' or ${table.dedupeKey} like 'automation:%') and ${table.answer} is null)))`,
    ),
    // Only core adds Automation alerts, with the reserved key prefix.
    check(
      "junior_inbox_items_owner_check",
      sql`(${table.ownerKind} = 'conversation' and ${table.dedupeKey} not like 'automation:%') or (${table.ownerKind} = 'automation' and ${table.dedupeKey} like 'automation:%')`,
    ),
    check(
      "junior_inbox_items_status_check",
      sql`(${table.status} = 'open' and ${table.closedAt} is null) or (${table.status} in ('done', 'dismissed') and ${table.closedAt} is not null)`,
    ),
    check(
      "junior_inbox_items_tenant_check",
      sql`(${table.provider} is null) = (${table.providerTenantId} is null)`,
    ),
    check(
      "junior_inbox_items_visibility_check",
      sql`${table.visibility} = 'public' or not ${table.assignedToEveryone}`,
    ),
    // Add with the key of an open item updates that item. Keys are unique
    // only inside one provider tenant, so tenants cannot collide.
    uniqueIndex("junior_inbox_items_open_dedupe_uidx")
      .on(
        sql`coalesce(${table.provider}, '')`,
        sql`coalesce(${table.providerTenantId}, '')`,
        table.dedupeKey,
      )
      .where(sql`${table.status} = 'open'`),
    index("junior_inbox_items_status_idx").on(
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("junior_inbox_items_subject_idx").on(table.subjectId, table.status),
    // Reads find the items of one owner, such as an Automation's alerts.
    index("junior_inbox_items_owner_idx").on(table.ownerKind, table.ownerId),
    // The Conversation status reads the open action items that each
    // Conversation owns.
    index("junior_inbox_items_open_action_owner_idx")
      .on(table.ownerId)
      .where(sql`${table.status} = 'open' and ${table.kind} = 'action'`),
    index("junior_inbox_items_automation_idx").on(
      table.automationId,
      table.status,
    ),
    // A feed row reads the viewer's newest answer in its Conversation.
    index("junior_inbox_items_answered_idx")
      .on(table.ownerId, table.closedByUserId, table.closedAt)
      .where(sql`${table.answer} is not null`),
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
