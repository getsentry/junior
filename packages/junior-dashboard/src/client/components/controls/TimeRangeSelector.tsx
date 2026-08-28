import { ToggleButton } from "../Button";

export type TimeRangeDays = 7 | 30 | 90;

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
      {(props.options ?? [7, 30, 90]).map((days) => (
        <ToggleButton
          key={days}
          onClick={() => props.onChange(days)}
          pressed={props.value === days}
          variant="segment"
        >
          {days}d
        </ToggleButton>
      ))}
    </div>
  );
}
