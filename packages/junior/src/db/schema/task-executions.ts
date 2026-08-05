import {
  bigint,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";

/** One successful task execution linked to its durable conversation. */
export const juniorTaskExecutions = pgTable(
  "junior_task_executions",
  {
    executionId: text("execution_id").notNull(),
    kind: text("kind").notNull(),
    namespace: text("namespace").notNull(),
    taskId: text("task_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    executedAtMs: bigint("executed_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
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
