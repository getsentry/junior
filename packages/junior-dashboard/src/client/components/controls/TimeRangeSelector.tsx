import { cn } from "../../styles";

export type TimeRangeDays = 7 | 30 | 90;

/** Select a fixed reporting window without hiding the active range. */
export function TimeRangeSelector(props: {
  onChange(value: TimeRangeDays): void;
  value: TimeRangeDays;
}) {
  return (
    <div
      aria-label="Reporting period"
      className="flex items-center gap-1"
      role="group"
    >
      {([7, 30, 90] as const).map((days) => (
        <button
          aria-pressed={props.value === days}
          className={cn(
            "h-7 min-w-10 cursor-pointer rounded border px-2 font-mono text-[0.68rem] transition-colors",
            props.value === days
              ? "border-amber-500/30 bg-amber-500/20 text-amber-400"
              : "border-white/10 bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60",
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
