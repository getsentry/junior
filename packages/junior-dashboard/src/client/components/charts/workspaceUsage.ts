import type { StatReport } from "@sentry/junior/api/schema";
import type { TimeRangeDays } from "../controls/TimeRangeSelector";

export type WorkspaceUsageDay = {
  count: number;
  date: string;
};

// TODO: build hour series once junior_stats stores hour keys for 24h usage.
/** UTC calendar day keys for the inclusive trailing window ending today. */
export function trailingUtcDates(
  range: TimeRangeDays,
  nowMs = Date.now(),
): string[] {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: range }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (range - 1 - index));
    return day.toISOString().slice(0, 10);
  });
}

/** Project daily switch counts for one Workspace over a trailing window. */
export function workspaceUsageDays(args: {
  workspaceId: string;
  nowMs?: number;
  range: TimeRangeDays;
  stats: StatReport[];
}): WorkspaceUsageDay[] {
  const byDate = new Map<string, number>();
  for (const stat of args.stats) {
    if (
      stat.namespace !== "junior" ||
      stat.metric !== "workspace_switch" ||
      stat.name !== args.workspaceId
    ) {
      continue;
    }
    byDate.set(stat.date, (byDate.get(stat.date) ?? 0) + stat.count);
  }
  return trailingUtcDates(args.range, args.nowMs).map((date) => ({
    count: byDate.get(date) ?? 0,
    date,
  }));
}
