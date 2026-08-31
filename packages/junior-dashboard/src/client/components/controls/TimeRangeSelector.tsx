import { ToggleButton } from "../Button";

export type TimeRangeDays = 1 | 7 | 30 | 90;

const DEFAULT_OPTIONS: TimeRangeDays[] = [1, 7, 30, 90];

/** Label a fixed reporting window without hiding the active range. */
export function timeRangeLabel(days: TimeRangeDays): string {
  return days === 1 ? "24h" : `${days}d`;
}

/** Describe a selected reporting window in plain copy. */
export function timeRangeDetail(days: TimeRangeDays): string {
  return days === 1 ? "last 24 hours" : `last ${days} days`;
}

/** Chart axis/average unit for the selected reporting window. */
export function timeRangeBucketUnit(days: TimeRangeDays): "day" | "hour" {
  return days === 1 ? "hour" : "day";
}

/** True when the selected range should plot hourly buckets. */
export function isHourlyTimeRange(days: TimeRangeDays): boolean {
  return days === 1;
}

/**
 * Choose the day or hour series for a reporting window.
 * Falls back to the trailing day window when hour data is absent.
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

/** Select a fixed reporting window without hiding the active range. */
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
