import { and, asc, gte, lte, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationMetrics } from "@/db/schema";
import type { ConversationMetric } from "@/db/schema/conversation-metrics";

export interface ConversationMetricBucket {
  date: string;
  metric: ConversationMetric;
  value: number;
}

/** Sum all Conversation metrics into UTC day or hour buckets. */
export async function readConversationMetricBuckets(
  db: JuniorDatabase,
  options: {
    bucket: "day" | "hour";
    start: Date;
    end: Date;
  },
): Promise<ConversationMetricBucket[]> {
  const date =
    options.bucket === "day"
      ? sql<string>`to_char(${juniorConversationMetrics.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`
      : sql<string>`to_char(${juniorConversationMetrics.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  return await db
    .select({
      date,
      metric: juniorConversationMetrics.metric,
      value: sql<number>`sum(${juniorConversationMetrics.value})::double precision`,
    })
    .from(juniorConversationMetrics)
    .where(
      and(
        gte(juniorConversationMetrics.occurredAt, options.start),
        lte(juniorConversationMetrics.occurredAt, options.end),
      ),
    )
    .groupBy(date, juniorConversationMetrics.metric)
    .orderBy(asc(date), asc(juniorConversationMetrics.metric));
}
