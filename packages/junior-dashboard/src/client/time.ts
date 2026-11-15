// All dashboard date, time, and duration formatting lives here. The dashboard
// UI is English only, so every label uses this locale in every browser. A
// Spanish browser must not get "hace 5 minutos" in an English UI.
const LOCALE = "en-US";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

// Days are the largest unit: idle and runtime thresholds count days, and
// narrow Intl writes months as `m`, which reads like minutes.
const DURATION_UNITS: Array<[Intl.DurationFormatUnit, number]> = [
  ["days", DAY_MS],
  ["hours", HOUR_MS],
  ["minutes", MINUTE_MS],
  ["seconds", SECOND_MS],
];

// Months and years use average lengths. A relative label only needs the
// nearest unit, not calendar math.
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * DAY_MS],
  ["month", MONTH_MS],
  ["week", WEEK_MS],
  ["day", DAY_MS],
  ["hour", HOUR_MS],
  ["minute", MINUTE_MS],
];

// The fields that `Date.prototype.toLocaleString` shows by default.
const DATE_AND_TIME: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "numeric",
  second: "2-digit",
  year: "numeric",
};

const durationFormat = new Intl.DurationFormat(LOCALE, { style: "narrow" });
const relativeTimeFormat = new Intl.RelativeTimeFormat(LOCALE, {
  numeric: "auto",
});

/** Read the viewer's own browser timezone, used for absolute timestamps and charts. */
export function getDashboardTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Build an English date formatter in the dashboard timezone, unless `options`
 * name another. Use it to reuse one formatter or to read `formatToParts`.
 */
export function dateTimeFormat(
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: getDashboardTimeZone(),
    ...options,
  });
}

function toTime(value: Date | number | string | undefined): number | undefined {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : value;
  return time !== undefined && Number.isFinite(time) ? time : undefined;
}

/**
 * Format an absolute date or time in the dashboard timezone, unless `options`
 * name another. Returns `none` for a missing or invalid time.
 */
export function formatTime(
  value: Date | number | string | undefined,
  options: Intl.DateTimeFormatOptions = DATE_AND_TIME,
): string {
  const time = toTime(value);
  return time === undefined ? "none" : dateTimeFormat(options).format(time);
}

/** Format transcript event timestamps independently from conversation start. */
export function formatMessageTimestamp(
  value: number | undefined,
  includeDate = false,
): string {
  if (toTime(value) === undefined) return "no timestamp";
  return formatTime(
    value,
    includeDate
      ? { dateStyle: "medium", timeStyle: "medium" }
      : { timeStyle: "medium" },
  );
}

/** Format canonical local and UTC values for a transcript timestamp. */
export function formatTranscriptTimestampDetails(value: number): {
  local: string;
  utc: string;
} {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "long",
  };
  return {
    local: formatTime(value, options),
    utc: formatTime(value, { ...options, timeZone: "UTC" }),
  };
}

/** Return the UTC midnight of the calendar day that holds `time` in `timeZone`. */
export function calendarDay(time: number, timeZone: string): number {
  const parts = dateTimeFormat({
    day: "numeric",
    month: "numeric",
    timeZone,
    year: "numeric",
  }).formatToParts(time);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  return Date.UTC(
    values.get("year") ?? 0,
    (values.get("month") ?? 1) - 1,
    values.get("day") ?? 1,
  );
}

/** Count the calendar days from `time` to `nowDay` (a `calendarDay` value). */
export function calendarDaysAgo(
  time: number,
  nowDay: number,
  timeZone: string,
): number {
  return Math.round((nowDay - calendarDay(time, timeZone)) / DAY_MS);
}

/**
 * Format an activity time as a short age for dense lists: `now`, `12m`, `3h`,
 * `2d`, `3w`, then a month and day.
 */
export function formatCompactAge(value: string, nowMs = Date.now()): string {
  const time = toTime(value);
  if (time === undefined) return "";

  const elapsed = Math.max(0, nowMs - time);
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < WEEK_MS) return formatDuration(elapsed, 1);
  if (elapsed < MONTH_MS) return `${Math.floor(elapsed / WEEK_MS)}w`;
  return formatTime(time, { day: "numeric", month: "short" });
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
  const time = toTime(value);
  if (time === undefined) return "";

  const days = calendarDaysAgo(time, calendarDay(nowMs, timeZone), timeZone);
  if (days <= 0) {
    return formatTime(time, { hour: "numeric", minute: "2-digit", timeZone });
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return formatTime(time, { timeZone, weekday: "short" });
  const year = (ms: number) => formatTime(ms, { timeZone, year: "numeric" });
  return formatTime(time, {
    day: "numeric",
    month: "short",
    timeZone,
    ...(year(time) === year(nowMs) ? undefined : { year: "numeric" }),
  });
}

function formatUnit(unit: "millisecond" | "second", value: number): string {
  const digits = unit === "second" && value < 10 ? 1 : 0;
  return new Intl.NumberFormat(LOCALE, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: "unit",
    unit,
    unitDisplay: "narrow",
  }).format(value);
}

/**
 * Format milliseconds as compact units: `999ms` and `3.5s` below a minute,
 * then the largest `maxUnits` non-zero units, such as `2h 5m` or `9d 17h`.
 */
export function formatDuration(
  value: number | undefined,
  maxUnits = 2,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  let remaining = Math.max(0, Math.floor(value));
  if (remaining < SECOND_MS) return formatUnit("millisecond", remaining);
  if (remaining < MINUTE_MS) {
    return formatUnit("second", remaining / SECOND_MS);
  }

  const duration: Partial<Record<Intl.DurationFormatUnit, number>> = {};
  let units = 0;
  for (const [unit, size] of DURATION_UNITS) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    duration[unit] = count;
    remaining %= size;
    if (++units === maxUnits) break;
  }
  return durationFormat.format(duration);
}

/** Format a duration that is empty when no time was recorded. */
export function formatRuntime(durationMs: number | undefined): string {
  return durationMs !== undefined && durationMs >= 1
    ? formatDuration(durationMs)
    : "";
}

/** Format the elapsed duration between two transcript event timestamps. */
export function formatElapsedDuration(
  startedAt: number | undefined,
  endedAt: number | undefined,
): string | undefined {
  if (
    typeof startedAt !== "number" ||
    typeof endedAt !== "number" ||
    endedAt < startedAt
  ) {
    return undefined;
  }
  return formatDuration(endedAt - startedAt);
}

/**
 * Format a time relative to now, such as `5 minutes ago`, `yesterday`, or
 * `in 2 hours`. Returns `fallback` for a missing or invalid time.
 */
export function formatRelativeTime(
  value: number | string | undefined,
  fallback = "not updated yet",
): string {
  const time = toTime(value);
  if (time === undefined) return fallback;

  const ms = time - Date.now();
  const unit = RELATIVE_UNITS.find(([, size]) => Math.abs(ms) >= size);
  if (!unit) return "just now";
  return relativeTimeFormat.format(Math.round(ms / unit[1]), unit[0]);
}
