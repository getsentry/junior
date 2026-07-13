import { sql } from "drizzle-orm";
import { juniorConversations } from "@/db/schema";

function tokenValue() {
  return sql<number | null>`
    CASE
      WHEN ${juniorConversations.usage}->>'totalTokens' IS NOT NULL
        THEN (${juniorConversations.usage}->>'totalTokens')::double precision
      WHEN COALESCE(
        ${juniorConversations.usage}->>'inputTokens',
        ${juniorConversations.usage}->>'outputTokens',
        ${juniorConversations.usage}->>'cachedInputTokens',
        ${juniorConversations.usage}->>'cacheCreationTokens'
      ) IS NOT NULL
        THEN COALESCE((${juniorConversations.usage}->>'inputTokens')::double precision, 0)
          + COALESCE((${juniorConversations.usage}->>'outputTokens')::double precision, 0)
          + COALESCE((${juniorConversations.usage}->>'cachedInputTokens')::double precision, 0)
          + COALESCE((${juniorConversations.usage}->>'cacheCreationTokens')::double precision, 0)
      ELSE NULL
    END
  `;
}

function costValue() {
  return sql<number | null>`
    CASE
      WHEN ${juniorConversations.usage}->'cost'->>'total' IS NOT NULL
        THEN (${juniorConversations.usage}->'cost'->>'total')::double precision
      WHEN COALESCE(
        ${juniorConversations.usage}->'cost'->>'input',
        ${juniorConversations.usage}->'cost'->>'output',
        ${juniorConversations.usage}->'cost'->>'cacheRead',
        ${juniorConversations.usage}->'cost'->>'cacheWrite'
      ) IS NOT NULL
        THEN COALESCE((${juniorConversations.usage}->'cost'->>'input')::double precision, 0)
          + COALESCE((${juniorConversations.usage}->'cost'->>'output')::double precision, 0)
          + COALESCE((${juniorConversations.usage}->'cost'->>'cacheRead')::double precision, 0)
          + COALESCE((${juniorConversations.usage}->'cost'->>'cacheWrite')::double precision, 0)
      ELSE NULL
    END
  `;
}

/** Select complete conversation metrics inside the database instead of materializing source rows. */
export function conversationAggregateColumns() {
  return {
    active: sql<number>`COUNT(*) FILTER (
      WHERE ${juniorConversations.executionStatus} NOT IN ('idle', 'failed')
    )::integer`,
    conversations: sql<number>`COUNT(*)::integer`,
    costUsd: sql<number | null>`SUM(${costValue()})::double precision`,
    durationMs: sql<number>`COALESCE(SUM(${juniorConversations.durationMs}), 0)::double precision`,
    failed: sql<number>`COUNT(*) FILTER (
      WHERE ${juniorConversations.executionStatus} = 'failed'
    )::integer`,
    tokens: sql<number | null>`SUM(${tokenValue()})::double precision`,
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
