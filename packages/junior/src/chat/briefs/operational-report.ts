import { and, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { readConversationEventCostsByDay } from "@/chat/plugins/conversation-event-stats";
import { juniorConversationBriefs } from "@/db/schema";
import type { PluginOperationalReport } from "@/reporting-schema";
import { BRIEF_EVENT_NAMESPACE, BRIEF_UPDATED_EVENT } from "./events";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOWS = [7, 30, 90] as const;

function startOfUtcDay(value: number): Date {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(value: number): string {
  const maximumFractionDigits = value > 0 && value < 0.01 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

/**
 * Build Brief storage and model-cost diagnostics for the System page. Cost
 * comes from retained Conversation events, so spend on purged private
 * Conversations leaves the report with them; the labels say so.
 */
export async function buildBriefsOperationalReport(
  nowMs: number,
): Promise<PluginOperationalReport> {
  const db = getDb();
  const newestDay = startOfUtcDay(nowMs);
  const windowStart = new Date(newestDay.getTime() - 29 * DAY_MS);
  const windowEnd = new Date(newestDay.getTime() + DAY_MS);
  const [briefDays, [counts], recentCounts] = await Promise.all([
    readConversationEventCostsByDay({
      days: 90,
      eventName: BRIEF_UPDATED_EVENT,
      namespace: BRIEF_EVENT_NAMESPACE,
      nowMs,
    }),
    db
      .select({
        conversations:
          sql<number>`count(distinct ${juniorConversationBriefs.conversationId})`.mapWith(
            Number,
          ),
        stored: sql<number>`count(*)`.mapWith(Number),
      })
      .from(juniorConversationBriefs),
    db
      .select({ stored: sql<number>`count(*)`.mapWith(Number) })
      .from(juniorConversationBriefs)
      .where(
        and(
          gte(juniorConversationBriefs.createdAt, windowStart),
          lt(juniorConversationBriefs.createdAt, windowEnd),
        ),
      ),
  ]);
  const recentDays = briefDays.filter((day) => {
    const dayStart = Date.parse(`${day.date}T00:00:00.000Z`);
    return dayStart >= windowStart.getTime() && dayStart < windowEnd.getTime();
  });
  const recentCost = recentDays.reduce((total, day) => total + day.costUsd, 0);
  const recentBriefs = recentDays.reduce((total, day) => total + day.events, 0);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    // The report feed name predates core Briefs; keep it stable.
    pluginName: BRIEF_EVENT_NAMESPACE,
    title: "Briefs",
    metrics: [
      {
        label: "briefs stored",
        tone: counts?.stored ? "good" : "neutral",
        value: formatCount(counts?.stored ?? 0),
      },
      {
        label: "conversations with a brief",
        value: formatCount(counts?.conversations ?? 0),
      },
      {
        label: "briefs · 30d",
        value: formatCount(recentCounts[0]?.stored ?? 0),
      },
      { label: "cost · 30d · retained", value: formatUsd(recentCost) },
      {
        label: "average cost per brief · 30d · retained",
        value: formatUsd(recentBriefs === 0 ? 0 : recentCost / recentBriefs),
      },
    ],
    widgets: [
      {
        categories: briefDays.map((day) => ({
          id: day.date,
          label: day.date,
          values: { briefs: day.events, costUsd: day.costUsd },
        })),
        description: "Stored Brief versions and estimated model cost",
        id: "briefs-created",
        series: [
          { key: "briefs", label: "Briefs" },
          { format: "usd", key: "costUsd", label: "Cost" },
        ],
        timeRangeDays: [...WINDOWS],
        title: "Briefs created",
        type: "bar_chart",
      },
    ],
  };
}
