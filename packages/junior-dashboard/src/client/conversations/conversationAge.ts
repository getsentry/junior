import { getDashboardTimeZone } from "../format";

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
