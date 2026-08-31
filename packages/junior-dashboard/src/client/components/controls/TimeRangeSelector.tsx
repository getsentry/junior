import { ToggleButton } from "../Button";

/**
 * Fixed dashboard reporting window.
 * `1` means last 24 hours (hourly charts). Other values are trailing day counts.
 */
export type TimeRangeDays = 1 | 7 | 30 | 90;

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
export function timeRangeBucketUnit(days: TimeRangeDays): "day" | "hour" {
  return days === 1 ? "hour" : "day";
}

/** True when the selected range should plot hourly buckets. */
export function isHourlyTimeRange(days: TimeRangeDays): boolean {
  return days === 1;
}

/**
 * Choose the day or hour series for a reporting window.
 * Uses hours for 24h when present; otherwise the latest day only.
 */
export function selectTimeSeries<T>(args: {
  days: readonly T[];
  hours?: readonly T[] | undefined;
  range: TimeRangeDays;
}): T[] {
  if (isHourlyTimeRange(args.range) && args.hours?.length) {
    return [...args.hours];
  }
  if (isHourlyTimeRange(args.range)) {
    return args.days.slice(-1);
  }
  return args.days.slice(-args.range);
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
