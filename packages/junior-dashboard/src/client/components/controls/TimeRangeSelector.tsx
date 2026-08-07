import { cn, dashboardInteractiveTextClass } from "../../styles";

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
        <button
          aria-pressed={props.value === days}
          className={cn(
            "h-7 min-w-10 cursor-pointer rounded border px-2 font-mono text-xs transition-colors",
            props.value === days
              ? "border-amber-500/30 bg-amber-500/20 text-amber-400"
              : cn(
                  "border-white/10 bg-white/5 hover:bg-white/10",
                  dashboardInteractiveTextClass,
                ),
          )}
          key={days}
          onClick={() => props.onChange(days)}
          type="button"
        >
          {days}d
        </button>
      ))}
    </div>
  );
}
