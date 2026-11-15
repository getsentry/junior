import { getDashboardTimeZone } from "../format";
import { formatDuration } from "../time";
import { calendarDay, calendarDaysAgo } from "./conversationSections";

const MINUTE_MS = 60_000;
const WEEK_MS = 7 * 86_400_000;
const MONTH_MS = 30 * 86_400_000;

/**
 * Format an activity time as a short age for dense lists: `now`, `12m`, `3h`,
 * `2d`, `3w`, then a month and day.
 */
export function formatCompactAge(value: string, nowMs = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";

  const elapsed = Math.max(0, nowMs - time);
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < WEEK_MS) return formatDuration(elapsed, 1);
  if (elapsed < MONTH_MS) return `${Math.floor(elapsed / WEEK_MS)}w`;
  return new Date(time).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: getDashboardTimeZone(),
  });
}

/**
 * Format an activity time as the day it happened: the clock time today,
 * `Yesterday`, the weekday within a week, then the month and day. The year
 * shows only when it is not the current year.
 */
export function formatActivityDay(
  value: string,
  nowMs = Date.now(),
  timeZone = getDashboardTimeZone(),
): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";

  const days = calendarDaysAgo(time, calendarDay(nowMs, timeZone), timeZone);
  if (days <= 0) {
    return new Date(time).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    });
  }
  if (days === 1) return "Yesterday";
  if (days < 7) {
    return new Date(time).toLocaleDateString("en-US", {
      timeZone,
      weekday: "short",
    });
  }
  const year = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", { timeZone, year: "numeric" });
  return new Date(time).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone,
    ...(year(time) === year(nowMs) ? undefined : { year: "numeric" }),
  });
}
