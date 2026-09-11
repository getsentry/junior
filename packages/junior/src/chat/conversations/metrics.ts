import { and, eq, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationMetrics, juniorConversations } from "@/db/schema";
import {
  CONVERSATION_METRICS,
  type ConversationMetric,
} from "@/db/schema/conversation-metrics";
import {
  agentTurnCostUsd,
  agentTurnTotalTokens,
  type AgentTurnUsage,
} from "@/chat/usage";

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Convert one Run summary to metric rows. */
export function conversationMetricValues(args: {
  durationMs: number;
  usage?: AgentTurnUsage;
}): Partial<Record<ConversationMetric, number>> {
  const usage = args.usage;
  return {
    duration_ms: Math.max(0, args.durationMs),
    total_tokens: agentTurnTotalTokens(usage),
    input_tokens: finite(usage?.inputTokens),
    output_tokens: finite(usage?.outputTokens),
    cached_input_tokens: finite(usage?.cachedInputTokens),
    cache_creation_tokens: finite(usage?.cacheCreationTokens),
    reasoning_tokens: finite(usage?.reasoningTokens),
    cost_usd: agentTurnCostUsd(usage),
  };
}

/** Replace one Run's metric rows and refresh its Conversation totals. */
export async function replaceConversationMetrics(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    runId: string;
    occurredAtMs: number;
    durationMs: number;
    usage?: AgentTurnUsage;
  },
): Promise<void> {
  await executor
    .db()
    .delete(juniorConversationMetrics)
    .where(
      and(
        eq(juniorConversationMetrics.conversationId, args.conversationId),
        eq(juniorConversationMetrics.runId, args.runId),
      ),
    );
  const metricValues = conversationMetricValues({
    durationMs: args.durationMs,
    usage: args.usage,
  });
  const values = CONVERSATION_METRICS.flatMap((metric) => {
    const value = metricValues[metric];
    return value === undefined
      ? []
      : [
          {
            conversationId: args.conversationId,
            runId: args.runId,
            metric,
            value,
            occurredAt: new Date(args.occurredAtMs),
          },
        ];
  });
  if (values.length > 0) {
    await executor.db().insert(juniorConversationMetrics).values(values);
  }
  const metric = (name: ConversationMetric) => sql<number>`(
    select sum(${juniorConversationMetrics.value})
    from ${juniorConversationMetrics}
    where ${juniorConversationMetrics.conversationId} = ${args.conversationId}
      and ${juniorConversationMetrics.metric} = ${name}
  )`;
  await executor
    .db()
    .update(juniorConversations)
    .set({
      durationMs: sql`coalesce(${metric("duration_ms")}, 0)`,
      usage: sql`jsonb_strip_nulls(jsonb_build_object(
        'totalTokens', ${metric("total_tokens")},
        'inputTokens', ${metric("input_tokens")},
        'outputTokens', ${metric("output_tokens")},
        'cachedInputTokens', ${metric("cached_input_tokens")},
        'cacheCreationTokens', ${metric("cache_creation_tokens")},
        'reasoningTokens', ${metric("reasoning_tokens")},
        'cost', case when ${metric("cost_usd")} is null then null
          else jsonb_build_object('total', ${metric("cost_usd")}) end
      ))`,
    })
    .where(eq(juniorConversations.conversationId, args.conversationId));
}
