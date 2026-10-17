import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

// TODO(dcramer): In PR 3 of #2176, drop the junior_event_tasks table, delete
// this file, and remove its export from src/db/schema.ts. Its rows now live in
// junior_automations, and no current code reads or writes it.
export const juniorEventAutomations = pgTable(
  "junior_event_tasks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    namespace: text("namespace").notNull(),
    identifier: text("identifier").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    status: text("status").notNull().default("active"),
    statusReason: text("status_reason"),
    title: text("title"),
    task: jsonb("task_json").notNull(),
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
