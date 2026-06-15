import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { ScheduledRun, ScheduledTask } from "../types";

export const juniorSchedulerTasks = pgTable(
  "junior_scheduler_tasks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    status: text("status").notNull(),
    nextRunAtMs: bigint("next_run_at_ms", { mode: "number" }),
    runNowAtMs: bigint("run_now_at_ms", { mode: "number" }),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    record: jsonb("record").$type<ScheduledTask>().notNull(),
  },
  (table) => [
    index("junior_scheduler_tasks_team_status_idx")
      .on(table.teamId, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
    index("junior_scheduler_tasks_run_now_due_idx")
      .on(table.runNowAtMs, table.createdAtMs, table.id)
      .where(
        sql`${table.status} = 'active' AND ${table.runNowAtMs} IS NOT NULL`,
      ),
    index("junior_scheduler_tasks_next_run_due_idx")
      .on(table.nextRunAtMs, table.createdAtMs, table.id)
      .where(
        sql`${table.status} = 'active' AND ${table.nextRunAtMs} IS NOT NULL`,
      ),
  ],
);

export const juniorSchedulerRuns = pgTable(
  "junior_scheduler_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    status: text("status").notNull(),
    scheduledForMs: bigint("scheduled_for_ms", { mode: "number" }).notNull(),
    record: jsonb("record").$type<ScheduledRun>().notNull(),
  },
  (table) => [
    index("junior_scheduler_runs_task_status_idx").on(
      table.taskId,
      table.status,
      table.scheduledForMs,
    ),
    index("junior_scheduler_runs_status_idx").on(
      table.status,
      table.scheduledForMs,
    ),
  ],
);
