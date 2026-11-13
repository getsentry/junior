import {
  doublePrecision,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { juniorIdentities } from "./identities";
import { timestamptz } from "./timestamps";

export const CONVERSATION_METRICS = [
  "duration_ms",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
  "cost_usd",
] as const;

export type ConversationMetric = (typeof CONVERSATION_METRICS)[number];

/**
 * One metric value for one Conversation Run. A Run is one Turn, so People
 * spend reads the Identity of the Turn Actor from these rows.
 */
export const juniorConversationMetrics = pgTable(
  "junior_conversation_metrics",
  {
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    metric: text("metric").$type<ConversationMetric>().notNull(),
    // Null when the Turn has no resolved Actor Identity.
    actorIdentityId: text("actor_identity_id").references(
      () => juniorIdentities.id,
    ),
    value: doublePrecision("value").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
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
    index("junior_conversation_metrics_actor_identity_occurred_at_idx").on(
      table.actorIdentityId,
      table.occurredAt,
    ),
    index("junior_conversation_metrics_occurred_at_metric_idx").on(
      table.occurredAt,
      table.metric,
    ),
  ],
);
