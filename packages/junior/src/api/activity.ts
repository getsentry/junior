import { z } from "zod";

import {
  WINDOW_SEVEN_DAY_HOURS,
  fillUtcDays,
  fillUtcHours,
  sumUtcHoursIntoSixHours,
} from "./reporting-window";

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

/**
 * Fill the trailing 7-day UTC hour window from known hour rows.
 * 24h charts use the last 24 points. 7d charts sum hours into 6-hour buckets.
 */
export function activityHours(
  hours: Map<string, DailyConversationActivity>,
  nowMs: number,
): DailyConversationActivity[] {
  return fillUtcHours({
    count: WINDOW_SEVEN_DAY_HOURS,
    empty: emptyActivityDay,
    nowMs,
    rows: hours,
  });
}

/**
 * Fill trailing 6-hour buckets from hour keys or hour rows.
 * Hour keys must be summed into 6-hour keys first.
 */
export function activitySixHours(
  hours:
    | Map<string, DailyConversationActivity>
    | readonly DailyConversationActivity[],
  nowMs: number,
): DailyConversationActivity[] {
  const series =
    hours instanceof Map ? activityHours(hours, nowMs) : [...hours];
  return sumUtcHoursIntoSixHours({
    empty: emptyActivityDay,
    hours: series,
    nowMs,
  });
}
