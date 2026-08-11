import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { juniorConversations } from "@/db/schema";

interface ConversationAggregateSource {
  conversationId: AnyPgColumn;
  durationMs: AnyPgColumn;
  executionStatus: AnyPgColumn;
  usage: AnyPgColumn;
}

function usageTokenValue(
  source: ConversationAggregateSource,
  field: "cachedInputTokens" | "inputTokens",
) {
  return sql<number | null>`CASE
    WHEN ${source.usage}->>${field} IS NOT NULL
      THEN (${source.usage}->>${field})::double precision
    ELSE NULL
  END`;
}

function tokenValue(source: ConversationAggregateSource) {
  return sql<number | null>`
    CASE
      WHEN COALESCE(
        ${source.usage}->>'inputTokens',
        ${source.usage}->>'outputTokens',
        ${source.usage}->>'cachedInputTokens',
        ${source.usage}->>'cacheCreationTokens'
      ) IS NOT NULL
        THEN COALESCE((${source.usage}->>'inputTokens')::double precision, 0)
          + COALESCE((${source.usage}->>'outputTokens')::double precision, 0)
          + COALESCE((${source.usage}->>'cachedInputTokens')::double precision, 0)
          + COALESCE((${source.usage}->>'cacheCreationTokens')::double precision, 0)
      WHEN ${source.usage}->>'totalTokens' IS NOT NULL
        THEN (${source.usage}->>'totalTokens')::double precision
      ELSE NULL
    END
  `;
}

function costValue(source: ConversationAggregateSource) {
  return sql<number | null>`
    CASE
      WHEN ${source.usage}->'cost'->>'total' IS NOT NULL
        THEN (${source.usage}->'cost'->>'total')::double precision
      WHEN COALESCE(
        ${source.usage}->'cost'->>'input',
        ${source.usage}->'cost'->>'output',
        ${source.usage}->'cost'->>'cacheRead',
        ${source.usage}->'cost'->>'cacheWrite'
      ) IS NOT NULL
        THEN COALESCE((${source.usage}->'cost'->>'input')::double precision, 0)
          + COALESCE((${source.usage}->'cost'->>'output')::double precision, 0)
          + COALESCE((${source.usage}->'cost'->>'cacheRead')::double precision, 0)
          + COALESCE((${source.usage}->'cost'->>'cacheWrite')::double precision, 0)
      ELSE NULL
    END
  `;
}

/** Select complete conversation metrics inside the database instead of materializing source rows. */
export function conversationAggregateColumns(sources?: {
  metrics: ConversationAggregateSource;
  roots: ConversationAggregateSource;
}) {
  const metrics = sources?.metrics ?? juniorConversations;
  const roots = sources?.roots ?? juniorConversations;
  const conversationCount = sources
    ? sql`COUNT(DISTINCT ${roots.conversationId})`
    : sql`COUNT(*)`;
  return {
    active: sql<number>`${conversationCount} FILTER (
      WHERE ${roots.executionStatus} NOT IN ('idle', 'failed')
    )::integer`,
    conversations: sql<number>`${conversationCount}::integer`,
    cachedInputTokens: sql<
      number | null
    >`SUM(${usageTokenValue(metrics, "cachedInputTokens")})::double precision`,
    costUsd: sql<number | null>`SUM(${costValue(metrics)})::double precision`,
    durationMs: sql<number>`COALESCE(SUM(${metrics.durationMs}), 0)::double precision`,
    failed: sql<number>`${conversationCount} FILTER (
      WHERE ${roots.executionStatus} = 'failed'
    )::integer`,
    inputTokens: sql<
      number | null
    >`SUM(${usageTokenValue(metrics, "inputTokens")})::double precision`,
    tokens: sql<number | null>`SUM(${tokenValue(metrics)})::double precision`,
  };
}

/** Select the complete first/last activity range for a grouped conversation aggregate. */
export function conversationRangeColumns() {
  return {
    firstSeenAt: sql`MIN(${juniorConversations.createdAt})`.mapWith(
      juniorConversations.createdAt,
    ),
    lastSeenAt: sql`MAX(${juniorConversations.lastActivityAt})`.mapWith(
      juniorConversations.lastActivityAt,
    ),
  };
}

/** Count distinct UTC activity dates without loading conversation timestamps into the app. */
export function conversationActiveDaysColumn() {
  return sql<number>`COUNT(DISTINCT (${juniorConversations.lastActivityAt} AT TIME ZONE 'UTC')::date)::integer`;
}
