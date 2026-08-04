import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/** One successful task execution linked to its durable conversation. */
export const juniorTaskExecutions = pgTable(
  "junior_task_executions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    namespace: text("namespace").notNull(),
    taskId: text("task_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    executedAtMs: bigint("executed_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
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
