import { getDashboardTimeZone } from "../format";
import { calendarDay } from "./conversationSections";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Format an activity time as a short age for dense lists: `now`, `12m`, `3h`,
 * `2d`, `3w`, then a month and day.
 */
export function formatCompactAge(value: string, nowMs = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";

  const minutes = Math.floor(Math.max(0, nowMs - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
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

  const days = Math.round(
    (calendarDay(nowMs, timeZone) - calendarDay(time, timeZone)) / DAY_MS,
  );
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
