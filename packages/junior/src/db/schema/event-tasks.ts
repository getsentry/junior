import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { EventTask } from "@/chat/event-tasks/types";

export const juniorEventTasks = pgTable(
  "junior_event_tasks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    namespace: text("namespace").notNull(),
    identifier: text("identifier").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    /** Short display title generated from the task instruction. */
    title: text("title"),
    task: jsonb("task_json").$type<EventTask>().notNull(),
  },
  (table) => [
    index("junior_event_tasks_team_idx").on(
      table.teamId,
      table.createdAtMs,
      table.id,
    ),
    index("junior_event_tasks_match_idx").on(
      table.namespace,
      table.identifier,
      table.createdAtMs,
      table.id,
    ),
  ],
);
