import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PlanItemStatus } from "@/chat/plan/types";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * Gives each Plan item its id and each change its version. One sequence
 * serves every Conversation, so history that a fork copies from its parent
 * never shows a version that the fork's own plan reuses.
 */
export const juniorPlanItemVersionSeq = pgSequence(
  "junior_plan_item_version_seq",
);

/**
 * One Plan item: work that a Conversation has not finished. At most one
 * assignee: a Conversation (the plan's own agent or one of its child agents)
 * or a User. An item without one belongs to the plan's own agent, so
 * deleting a User keeps the items assigned to them. `changed_by_user_id` is set when a person made the latest
 * change, and null when the plan's own agent did.
 */
export const juniorPlanItems = pgTable(
  "junior_plan_items",
  {
    conversationId: text("conversation_id").notNull(),
    id: bigint("id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    status: text("status").$type<PlanItemStatus>().notNull(),
    assigneeConversationId: text("assignee_conversation_id"),
    assigneeUserId: text("assignee_user_id").references(() => juniorUsers.id, {
      onDelete: "set null",
    }),
    version: bigint("version", { mode: "number" }).notNull(),
    changedByUserId: text("changed_by_user_id").references(
      () => juniorUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_plan_items_pk",
      columns: [table.conversationId, table.id],
    }),
    foreignKey({
      name: "junior_plan_items_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    check(
      "junior_plan_items_status_check",
      sql`${table.status} in ('pending', 'in_progress', 'blocked', 'done', 'cancelled')`,
    ),
    check(
      "junior_plan_items_assignee_check",
      sql`${table.assigneeConversationId} is null or ${table.assigneeUserId} is null`,
    ),
    // Each assignee works on at most one item at a time.
    uniqueIndex("junior_plan_items_in_progress_uidx")
      .on(
        table.conversationId,
        sql`coalesce(${table.assigneeConversationId}, ${table.assigneeUserId}, ${table.conversationId})`,
      )
      .where(sql`${table.status} = 'in_progress'`),
  ],
);
