import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
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
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    version: integer("version").notNull(),
    destination: jsonb("destination").notNull(),
    createdBy: jsonb("created_by").notNull(),
    conversationAccess: jsonb("conversation_access"),
    credentialSubject: jsonb("credential_subject"),
    executionActor: jsonb("execution_actor"),
    lastRunAtMs: bigint("last_run_at_ms", { mode: "number" }),
    originalRequest: text("original_request"),
    schedule: jsonb("schedule").notNull(),
    statusReason: text("status_reason"),
    task: jsonb("task").notNull(),
    record: jsonb("record").$type<ScheduledTask>().notNull(),
  },
  (table) => [
    index("junior_scheduler_tasks_team_status_idx").on(
      table.teamId,
      table.status,
      table.createdAtMs,
    ),
    index("junior_scheduler_tasks_due_idx").on(
      table.status,
      table.runNowAtMs,
      table.nextRunAtMs,
    ),
  ],
);

export const juniorSchedulerRuns = pgTable(
  "junior_scheduler_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    status: text("status").notNull(),
    claimedAtMs: bigint("claimed_at_ms", { mode: "number" }).notNull(),
    scheduledForMs: bigint("scheduled_for_ms", { mode: "number" }).notNull(),
    startedAtMs: bigint("started_at_ms", { mode: "number" }),
    completedAtMs: bigint("completed_at_ms", { mode: "number" }),
    dispatchId: text("dispatch_id"),
    errorMessage: text("error_message"),
    idempotencyKey: text("idempotency_key").notNull(),
    resultMessageTs: text("result_message_ts"),
    taskVersion: integer("task_version").notNull(),
    attempt: integer("attempt").notNull(),
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
