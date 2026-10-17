import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

// TODO(dcramer): Drop this table after no deployed worker uses it. Its rows
// moved to junior_automations, and current code does not read it (#2176).
export const juniorEventAutomations = pgTable(
  "junior_event_tasks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    namespace: text("namespace").notNull(),
    identifier: text("identifier").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    /** Retained row status. Deleted tasks keep history but stop matching. */
    status: text("status").notNull().default("active"),
    /** Why a run blocked this automation. Kept while paused; cleared on resume. */
    statusReason: text("status_reason"),
    /** Short display title generated from the task instruction. */
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
