import { z } from "zod";

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

/** Fill a fixed UTC date window from sparse conversation activity. */
export function activityDays(
  days: Map<string, DailyConversationActivity>,
  nowMs: number,
  count: number,
): DailyConversationActivity[] {
  const items: DailyConversationActivity[] = [];
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (count - 1));

  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    items.push(days.get(date) ?? emptyActivityDay(date));
  }
  return items;
}
