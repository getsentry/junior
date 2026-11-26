import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
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
  // Whole micro-USD. A double holds every integer up to 2^53 exactly.
  "cost_micro_usd",
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
      name: "junior_conversation_metrics_conversation_id_junior_conversation",
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
    // Covers time-bounded reads of Turn duration, tokens, and cost, such as
    // the People list, so they scan only the index. Drizzle cannot declare
    // statistics, so `junior_conversation_metrics_utc_day_actor` lives only
    // in its migration.
    index("junior_conversation_metrics_turn_metric_occurred_at_idx")
      .on(
        table.metric,
        table.occurredAt,
        table.actorIdentityId,
        table.conversationId,
        table.value,
      )
      .where(
        sql`${table.metric} IN ('duration_ms', 'total_tokens', 'cost_micro_usd')`,
      ),
  ],
);

/**
 * Turn `duration_ms` and `cost_micro_usd` rows summed per UTC day and Actor
 * Identity, so a read of daily spend per person reads one row per Identity
 * and day, not one per Turn. A trigger on `junior_conversation_metrics` adds
 * each write to its row in the same transaction. Drizzle cannot declare
 * triggers, so `junior_conversation_metric_days_apply` lives only in its
 * migration.
 */
export const juniorConversationMetricDays = pgTable(
  "junior_conversation_metric_days",
  {
    day: date("day", { mode: "string" }).notNull(),
    // Null for Turns with no resolved Actor Identity.
    actorIdentityId: text("actor_identity_id"),
    // `duration_ms` and `cost_micro_usd` rows. Zero after every Turn of the
    // day is deleted, so a read skips the row.
    metricRows: integer("metric_rows").notNull(),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("junior_conversation_metric_days_day_actor_unique")
      .on(table.day, table.actorIdentityId)
      .nullsNotDistinct(),
  ],
);
