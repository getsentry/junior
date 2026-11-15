const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

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
  ["month", 30 * DAY_MS],
  ["week", WEEK_MS],
  ["day", DAY_MS],
  ["hour", HOUR_MS],
  ["minute", MINUTE_MS],
];

// Compact labels such as `3h` are English in every locale, like the rest of
// the dense dashboard metadata.
const durationFormat = new Intl.DurationFormat("en-US", { style: "narrow" });
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

function formatUnit(unit: "millisecond" | "second", value: number): string {
  const digits = unit === "second" && value < 10 ? 1 : 0;
  return new Intl.NumberFormat("en-US", {
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
  const time = typeof value === "string" ? Date.parse(value) : value;
  if (time === undefined || !Number.isFinite(time)) return fallback;

  const ms = time - Date.now();
  const unit = RELATIVE_UNITS.find(([, size]) => Math.abs(ms) >= size);
  if (!unit) return "just now";
  return relativeTimeFormat.format(Math.round(ms / unit[1]), unit[0]);
}
