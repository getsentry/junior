import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { TodoStatus } from "@/chat/todos/types";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * Gives each To-do its id and each change its version. One sequence serves
 * every Conversation, so history that a fork copies from its parent never
 * shows a version that the fork's own To-dos reuse.
 */
export const juniorTodoVersionSeq = pgSequence("junior_todo_version_seq");

/**
 * The words of a To-do title for search. The `simple` config keeps each
 * word as typed, so a prefix of it matches.
 */
export function todoSearchDocument(table: { title: AnyPgColumn }): SQL {
  return sql`to_tsvector('simple', ${table.title})`;
}

/** The lowercase title of a To-do, for typo-tolerant search. */
export function todoFuzzyTitle(table: { title: AnyPgColumn }): SQL {
  return sql`lower(${table.title})`;
}

/**
 * One To-do: work that a Conversation has not finished. At most one
 * assignee: a Conversation (the list's own agent or one of its child agents)
 * or a User. A To-do without one belongs to the list's own agent.
 * `changed_by_user_id` is set when a person made the latest change.
 * `changed_by_conversation_id` is set when the assignee child agent closed
 * it, or core closed it on that child's result. Both are null when the
 * list's own agent made the latest change. Both User keys block deleting the User, as
 * Conversation participants do: setting them null would turn a person's
 * To-do into the agent's and hide an unseen change from `<todo-delta>`.
 */
export const juniorTodos = pgTable(
  "junior_todos",
  {
    conversationId: text("conversation_id").notNull(),
    id: bigint("id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    status: text("status").$type<TodoStatus>().notNull(),
    assigneeConversationId: text("assignee_conversation_id"),
    assigneeUserId: text("assignee_user_id").references(() => juniorUsers.id),
    version: bigint("version", { mode: "number" }).notNull(),
    changedByUserId: text("changed_by_user_id").references(
      () => juniorUsers.id,
    ),
    changedByConversationId: text("changed_by_conversation_id"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_todos_pk",
      columns: [table.conversationId, table.id],
    }),
    foreignKey({
      name: "junior_todos_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    check(
      "junior_todos_status_check",
      sql`${table.status} in ('open', 'in_progress', 'done', 'dropped')`,
    ),
    check(
      "junior_todos_assignee_check",
      sql`${table.assigneeConversationId} is null or ${table.assigneeUserId} is null`,
    ),
    index("junior_todos_search_idx").using("gin", todoSearchDocument(table)),
    index("junior_todos_title_trgm_idx").using(
      "gin",
      sql`${todoFuzzyTitle(table)} gin_trgm_ops`,
    ),
  ],
);
