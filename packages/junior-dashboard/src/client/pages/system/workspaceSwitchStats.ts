import type { StatReport } from "@sentry/junior/api/schema";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";

export type WorkspaceSwitchDay = {
  count: number;
  date: string;
};

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

/** Project daily switch counts for one Workspace name over a trailing window. */
export function workspaceSwitchDays(args: {
  name: string;
  nowMs?: number;
  range: TimeRangeDays;
  stats: StatReport[];
}): WorkspaceSwitchDay[] {
  const byDate = new Map<string, number>();
  for (const stat of args.stats) {
    if (
      stat.namespace !== "junior" ||
      stat.metric !== "workspace_switch" ||
      stat.name !== args.name
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
