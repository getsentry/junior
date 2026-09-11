import {
  doublePrecision,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

export const CONVERSATION_METRICS = [
  "duration_ms",
  "tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
  "cost_usd",
] as const;

export type ConversationMetric = (typeof CONVERSATION_METRICS)[number];

/** One metric value for one Conversation Run. */
export const juniorConversationMetrics = pgTable(
  "junior_conversation_metrics",
  {
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    metric: text("metric").$type<ConversationMetric>().notNull(),
    value: doublePrecision("value").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_metrics_conversation_id_run_id_metric_pk",
      columns: [table.conversationId, table.runId, table.metric],
    }),
    foreignKey({
      name: "junior_conversation_metrics_conversation_id_junior_conversations_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }),
    index("junior_conversation_metrics_occurred_at_metric_idx").on(
      table.occurredAt,
      table.metric,
    ),
  ],
);
