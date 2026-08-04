import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

/** Daily successful execution counters owned by individual tasks. */
export const juniorTaskExecutions = pgTable(
  "junior_task_executions",
  {
    date: date("date", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    namespace: text("namespace").notNull(),
    taskId: text("task_id").notNull(),
    count: integer("count").notNull().default(0),
    lastExecutedAtMs: bigint("last_executed_at_ms", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_task_executions_date_kind_namespace_task_id_pk",
      columns: [table.date, table.kind, table.namespace, table.taskId],
    }),
    index("junior_task_executions_task_date_idx").on(
      table.kind,
      table.namespace,
      table.taskId,
      table.date,
    ),
    index("junior_task_executions_kind_date_idx").on(table.kind, table.date),
  ],
);
