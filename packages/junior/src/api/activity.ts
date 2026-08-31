import { z } from "zod";

import { fillUtcDays, fillUtcHours } from "./reporting-window";

export const dailyConversationActivitySchema = z
  .object({
    active: z.number(),
    conversations: z.number(),
    date: z.string(),
    durationMs: z.number(),
    failed: z.number(),
    tokens: z.number().optional(),
  })
  .strict();

export type DailyConversationActivity = z.infer<
  typeof dailyConversationActivitySchema
>;

/** Build a zeroed day for conversation activity projections. */
export function emptyActivityDay(date: string): DailyConversationActivity {
  return {
    active: 0,
    conversations: 0,
    date,
    durationMs: 0,
    failed: 0,
  };
}

/** Fill a fixed UTC day window from sparse conversation activity. */
export function activityDays(
  days: Map<string, DailyConversationActivity>,
  nowMs: number,
  count: number,
): DailyConversationActivity[] {
  return fillUtcDays({
    count,
    empty: emptyActivityDay,
    nowMs,
    rows: days,
  });
}

/** Fill the trailing UTC hour window from sparse conversation activity. */
export function activityHours(
  hours: Map<string, DailyConversationActivity>,
  nowMs: number,
): DailyConversationActivity[] {
  return fillUtcHours({
    empty: emptyActivityDay,
    nowMs,
    rows: hours,
  });
}
