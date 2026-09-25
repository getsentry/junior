import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { EventAutomation } from "@/chat/event-automations/types";

/** Terminal lifecycle status for one retained event automation row. */
export type EventAutomationStatus = "active" | "deleted";

export const juniorEventAutomations = pgTable(
  // Keep the deployed table name until a later storage migration.
  "junior_event_tasks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    namespace: text("namespace").notNull(),
    identifier: text("identifier").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    /** Retained row status. Deleted tasks keep history but stop matching. */
    status: text("status")
      .$type<EventAutomationStatus>()
      .notNull()
      .default("active"),
    /** Short display title generated from the task instruction. */
    title: text("title"),
    task: jsonb("task_json").$type<EventAutomation>().notNull(),
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
