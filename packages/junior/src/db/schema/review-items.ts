import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  UserInputAnswer,
  UserInputRequest,
} from "@/chat/tools/runtime/user-input-request";
import { juniorAutomations } from "./automations";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * One Review item: something that needs a person. See
 * `chat/review-items/README.md`. An action item stores its `request`, and
 * its `answer` after an assignee submits it. `closed_at` is set for `done`
 * and `dismissed`. `closed_by_user_id` is null when an agent closed it.
 */
export const juniorReviewItems = pgTable(
  "junior_review_items",
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
    request: jsonb("request").$type<UserInputRequest>(),
    answer: jsonb("answer").$type<UserInputAnswer>(),
    assignedToEveryone: boolean("assigned_to_everyone")
      .notNull()
      .default(false),
    dedupeKey: text("dedupe_key").notNull(),
    subjectId: text("subject_id"),
    subjectTitle: text("subject_title"),
    subjectUrl: text("subject_url"),
    /** Conversation of the agent that added the item. */
    addedByConversationId: text("added_by_conversation_id").notNull(),
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
    closedByUserId: text("closed_by_user_id").references(() => juniorUsers.id),
    closeReason: text("close_reason"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check(
      "junior_review_items_kind_check",
      sql`(${table.kind} = 'notice' and ${table.request} is null and ${table.answer} is null) or (${table.kind} = 'action' and ${table.request} is not null)`,
    ),
    check(
      "junior_review_items_status_check",
      sql`(${table.status} = 'open' and ${table.closedAt} is null) or (${table.status} in ('done', 'dismissed') and ${table.closedAt} is not null)`,
    ),
    check(
      "junior_review_items_tenant_check",
      sql`(${table.provider} is null) = (${table.providerTenantId} is null)`,
    ),
    check(
      "junior_review_items_visibility_check",
      sql`${table.visibility} = 'public' or not ${table.assignedToEveryone}`,
    ),
    // Add with the key of an open item updates that item.
    uniqueIndex("junior_review_items_open_dedupe_uidx")
      .on(table.dedupeKey)
      .where(sql`${table.status} = 'open'`),
    index("junior_review_items_status_idx").on(
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("junior_review_items_subject_idx").on(table.subjectId, table.status),
    index("junior_review_items_automation_idx").on(
      table.automationId,
      table.status,
    ),
  ],
);

/** The assigned Users of a Review item. Everyone is a flag on the item. */
export const juniorReviewItemAssignees = pgTable(
  "junior_review_item_assignees",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => juniorReviewItems.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.userId] }),
    index("junior_review_item_assignees_user_idx").on(table.userId),
  ],
);

/** The Conversations linked to a Review item. */
export const juniorReviewItemConversations = pgTable(
  "junior_review_item_conversations",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => juniorReviewItems.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.conversationId] }),
    index("junior_review_item_conversations_conversation_idx").on(
      table.conversationId,
    ),
  ],
);
