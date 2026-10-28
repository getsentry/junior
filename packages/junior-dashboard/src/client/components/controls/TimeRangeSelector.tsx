import { ToggleButton } from "../Button";

/**
 * Fixed dashboard reporting window.
 * `1` means last 24 hours (hourly charts). `7` means last 7 days in 6-hour buckets.
 * Other values are trailing day counts.
 */
export type TimeRangeDays = 1 | 7 | 30 | 90;

/** Chart axis and average unit for a reporting window. */
export type TimeRangeBucketUnit = "day" | "hour" | "6hour";

const DEFAULT_OPTIONS: TimeRangeDays[] = [1, 7, 30, 90];

/** Short control label for a reporting window. */
export function timeRangeLabel(days: TimeRangeDays): string {
  return days === 1 ? "24h" : `${days}d`;
}

/** Plain-language description of a reporting window. */
export function timeRangeDetail(days: TimeRangeDays): string {
  return days === 1 ? "last 24 hours" : `last ${days} days`;
}

/** Chart axis and average unit for a reporting window. */
export function timeRangeBucketUnit(days: TimeRangeDays): TimeRangeBucketUnit {
  if (days === 1) return "hour";
  if (days === 7) return "6hour";
  return "day";
}

/** True when the selected range should plot hourly buckets. */
export function isHourlyTimeRange(days: TimeRangeDays): boolean {
  return days === 1;
}

/** True when the selected range should plot 6-hour buckets. */
export function isSixHourTimeRange(days: TimeRangeDays): boolean {
  return days === 7;
}

/** Average-line unit label for a bucket unit. */
export function timeRangeBucketAverageUnit(unit: TimeRangeBucketUnit): string {
  if (unit === "hour") return "hour";
  if (unit === "6hour") return "6h";
  return "day";
}

/** Human label for chart titles ("per hour" / "per 6 hours" / "per day"). */
export function timeRangeBucketPerLabel(unit: TimeRangeBucketUnit): string {
  if (unit === "hour") return "hour";
  if (unit === "6hour") return "6 hours";
  return "day";
}

/** Title-case adjective for chart copy ("Hourly" / "6-hour" / "Daily"). */
export function timeRangeBucketAdjective(unit: TimeRangeBucketUnit): string {
  if (unit === "hour") return "Hourly";
  if (unit === "6hour") return "6-hour";
  return "Daily";
}

/**
 * Choose the day, hour, or 6-hour series for a reporting window.
 * For 7d, prefer a sixHours series. If missing, sum hours into 6-hour buckets.
 * For 24h, use hours when present; otherwise use the latest day only.
 */
export function selectTimeSeries<T extends { date: string }>(args: {
  days: readonly T[];
  hours?: readonly T[] | undefined;
  sixHours?: readonly T[] | undefined;
  range: TimeRangeDays;
  emptySixHour?(date: string): T;
}): T[] {
  if (isHourlyTimeRange(args.range) && args.hours?.length) {
    // 24h views keep the last 24 hour points even if more hours are present.
    return args.hours.slice(-24);
  }
  if (isHourlyTimeRange(args.range)) {
    return args.days.slice(-1);
  }
  if (isSixHourTimeRange(args.range)) {
    if (args.sixHours?.length) {
      return [...args.sixHours];
    }
    if (args.hours?.length && args.emptySixHour) {
      return sumHoursIntoSixHours({
        empty: args.emptySixHour,
        hours: args.hours,
      });
    }
    // No hour or 6-hour series: use daily points so the chart still renders.
    return args.days.slice(-args.range);
  }
  return args.days.slice(-args.range);
}

/** Sum hour rows into 6-hour buckets when the API only returns hours. */
function sumHoursIntoSixHours<T extends { date: string }>(args: {
  empty(date: string): T;
  hours: readonly T[];
}): T[] {
  const bySix = new Map<string, T>();
  for (const hour of args.hours) {
    const startMs = Date.parse(`${hour.date}:00:00.000Z`);
    if (Number.isNaN(startMs)) continue;
    const bucket = new Date(startMs);
    bucket.setUTCMinutes(0, 0, 0);
    bucket.setUTCHours(Math.floor(bucket.getUTCHours() / 6) * 6, 0, 0, 0);
    const key = bucket.toISOString().slice(0, 13);
    const current = bySix.get(key) ?? args.empty(key);
    const next = { ...current, date: key } as T;
    for (const [field, value] of Object.entries(hour)) {
      if (field === "date") continue;
      if (typeof value === "number") {
        const prior = (next as Record<string, unknown>)[field];
        (next as Record<string, unknown>)[field] =
          (typeof prior === "number" ? prior : 0) + value;
      }
    }
    bySix.set(key, next);
  }

  // Fill the trailing 28 six-hour buckets when enough hour rows exist.
  if (args.hours.length >= 24) {
    const lastHour = args.hours[args.hours.length - 1]?.date;
    const endMs = lastHour
      ? Date.parse(`${lastHour}:00:00.000Z`)
      : Date.now();
    const end = new Date(endMs);
    end.setUTCMinutes(0, 0, 0);
    end.setUTCHours(Math.floor(end.getUTCHours() / 6) * 6, 0, 0, 0);
    const start = new Date(end.getTime() - 27 * 6 * 60 * 60 * 1_000);
    const items: T[] = [];
    for (
      const cursor = new Date(start);
      cursor.getTime() <= end.getTime();
      cursor.setTime(cursor.getTime() + 6 * 60 * 60 * 1_000)
    ) {
      const key = cursor.toISOString().slice(0, 13);
      items.push(bySix.get(key) ?? args.empty(key));
    }
    return items;
  }

  return [...bySix.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

/** Control for a fixed reporting window. */
export function TimeRangeSelector(props: {
  onChange(value: TimeRangeDays): void;
  options?: TimeRangeDays[];
  value: TimeRangeDays;
}) {
  return (
    <div
      aria-label="Reporting period"
      className="flex items-center gap-1"
      role="group"
    >
      {(props.options ?? DEFAULT_OPTIONS).map((days) => (
        <ToggleButton
          key={days}
          onClick={() => props.onChange(days)}
          pressed={props.value === days}
          variant="segment"
        >
          {timeRangeLabel(days)}
        </ToggleButton>
      ))}
    </div>
  );
}
