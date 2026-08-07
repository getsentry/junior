import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";

/** Terminal outcome recorded for one task execution. */
export type TaskExecutionStatus = "blocked" | "completed" | "failed";

/** One terminal task execution linked to its durable conversation when present. */
export const juniorTaskExecutions = pgTable(
  "junior_task_executions",
  {
    executionId: text("execution_id").notNull(),
    kind: text("kind").notNull(),
    namespace: text("namespace").notNull(),
    taskId: text("task_id").notNull(),
    conversationId: text("conversation_id"),
    executedAtMs: bigint("executed_at_ms", { mode: "number" }).notNull(),
    status: text("status").$type<TaskExecutionStatus>().notNull(),
  },
  (table) => [
    check(
      "junior_task_executions_kind_check",
      sql`${table.kind} in ('scheduled', 'event')`,
    ),
    check(
      "junior_task_executions_status_check",
      sql`${table.status} in ('blocked', 'completed', 'failed')`,
    ),
    primaryKey({
      name: "junior_task_executions_kind_namespace_execution_id_pk",
      columns: [table.kind, table.namespace, table.executionId],
    }),
    foreignKey({
      name: "junior_task_executions_conversation_id_junior_conversations_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }),
    index("junior_task_executions_task_time_idx").on(
      table.kind,
      table.namespace,
      table.taskId,
      table.executedAtMs,
    ),
    index("junior_task_executions_time_kind_idx").on(
      table.executedAtMs,
      table.kind,
    ),
    index("junior_task_executions_conversation_time_idx").on(
      table.conversationId,
      table.executedAtMs,
    ),
  ],
);
