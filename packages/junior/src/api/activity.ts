import { z } from "zod";

import {
  WINDOW_SEVEN_DAY_HOURS,
  fillUtcDays,
  fillUtcHours,
  rollupUtcHoursToSixHours,
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
 * Fill the trailing 7-day UTC hour window from sparse conversation activity.
 * 24h charts slice the trailing 24 points; 7d charts roll these into 6h buckets.
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
 * Fill trailing 6-hour buckets from hour-keyed sparse maps or dense hour rows.
 * Hour keys must roll up; do not look them up as 6h keys.
 */
export function activitySixHours(
  hours:
    | Map<string, DailyConversationActivity>
    | readonly DailyConversationActivity[],
  nowMs: number,
): DailyConversationActivity[] {
  const series =
    hours instanceof Map ? activityHours(hours, nowMs) : [...hours];
  return rollupUtcHoursToSixHours({
    empty: emptyActivityDay,
    hours: series,
    nowMs,
  });
}
