import { and, asc, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationMetrics, juniorSandboxSessions } from "@/db/schema";
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

export interface SandboxCostBucket {
  date: string;
  value: number;
}

/**
 * Sum estimated Sandbox session costs into UTC day or hour buckets, by the
 * time each session started.
 */
export async function readSandboxCostBuckets(
  db: JuniorDatabase,
  options: {
    bucket: "day" | "hour";
    start: Date;
    end: Date;
  },
): Promise<SandboxCostBucket[]> {
  const date =
    options.bucket === "day"
      ? sql<string>`to_char(${juniorSandboxSessions.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`
      : sql<string>`to_char(${juniorSandboxSessions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  return await db
    .select({
      date,
      value: sql<number>`sum(${juniorSandboxSessions.costUsd})::double precision`,
    })
    .from(juniorSandboxSessions)
    .where(
      and(
        isNotNull(juniorSandboxSessions.costUsd),
        gte(juniorSandboxSessions.createdAt, options.start),
        lte(juniorSandboxSessions.createdAt, options.end),
      ),
    )
    .groupBy(date)
    .orderBy(asc(date));
}
