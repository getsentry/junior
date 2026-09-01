import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { EventTask } from "@/chat/event-tasks/types";

/** Terminal lifecycle status for one retained event task row. */
export type EventTaskStatus = "active" | "deleted";

export const juniorEventTasks = pgTable(
  "junior_event_tasks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    namespace: text("namespace").notNull(),
    identifier: text("identifier").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    /** Retained row status. Deleted tasks keep history but stop matching. */
    status: text("status").$type<EventTaskStatus>().notNull().default("active"),
    /** Short display title generated from the task instruction. */
    title: text("title"),
    task: jsonb("task_json").$type<EventTask>().notNull(),
  },
  (table) => [
    index("junior_event_tasks_team_idx")
      .on(table.teamId, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
    index("junior_event_tasks_match_idx")
      .on(table.namespace, table.identifier, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
  ],
);
