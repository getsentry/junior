import { formatDuration } from "./Duration";
import { Tooltip } from "./Tooltip";
import { cn } from "../styles";

type ContributionDay = {
  conversations: number;
  date: string;
  durationMs: number;
};

/** Render a calendar grid for daily conversation activity. */
export function ContributionGrid(props: { days: ContributionDay[] }) {
  const max = Math.max(1, ...props.days.map((day) => day.conversations));
  const weeks: Array<Array<ContributionDay | null>> = [];
  const leadingDays = props.days[0]
    ? new Date(`${props.days[0].date}T00:00:00Z`).getUTCDay()
    : 0;
  const cells: Array<ContributionDay | null> = [
    ...Array.from({ length: leadingDays }, () => null),
    ...props.days,
  ];
  while (cells.length > 0 && cells.length % 7 !== 0) cells.push(null);
  for (let index = 0; index < cells.length; index += 7) {
    const week: Array<ContributionDay | null> = cells.slice(index, index + 7);
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  if (weeks.length === 0) {
    weeks.push([null, null, null, null, null, null, null]);
  }
  const monthLabels = weeks.map((week, index) => {
    const firstDay = week.find(Boolean);
    if (!firstDay) return "";
    const previousWeek = index > 0 ? weeks[index - 1] : undefined;
    const previousDay = previousWeek
      ? [...previousWeek].reverse().find(Boolean)
      : undefined;
    if (
      previousDay &&
      previousDay.date.slice(0, 7) === firstDay.date.slice(0, 7)
    ) {
      return "";
    }
    return new Date(`${firstDay.date}T00:00:00Z`).toLocaleString(undefined, {
      month: "short",
      timeZone: "UTC",
    });
  });

  return (
    <div className="overflow-x-auto px-4 py-4">
      <div className="min-w-[36rem]">
        <div
          aria-hidden="true"
          className="mb-1 grid gap-1 text-[0.64rem] font-semibold leading-none text-[#666]"
          style={{
            gridTemplateColumns: `repeat(${weeks.length}, minmax(0.75rem, 1fr))`,
          }}
        >
          {monthLabels.map((label, index) => (
            <div className="h-3 overflow-visible" key={`${label}-${index}`}>
              {label}
            </div>
          ))}
        </div>
        <div
          aria-label="Daily Junior conversation activity"
          className="grid w-full grid-flow-col grid-rows-7 gap-1"
          role="list"
          style={{
            gridTemplateColumns: `repeat(${weeks.length}, minmax(0.75rem, 1fr))`,
          }}
        >
          {weeks.flatMap((week, weekIndex) =>
            week.map((day, dayIndex) =>
              day ? (
                <Tooltip
                  content={
                    <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
                      <span className="text-white/40">conversations</span>
                      <span className="text-right text-white/80">
                        {day.conversations}
                      </span>
                      <span className="text-white/40">runtime</span>
                      <span className="text-right text-white/80">
                        {activityRuntime(day)}
                      </span>
                    </div>
                  }
                  key={day.date}
                  label={formatDate(day.date)}
                >
                  <span
                    aria-label={`${day.date}: ${day.conversations} conversations, ${activityRuntime(day)}`}
                    className={cn(
                      "size-3 border border-black/40 outline-none focus-visible:ring-2 focus-visible:ring-[#beaaff]",
                      activityClass(day.conversations, max),
                    )}
                    role="listitem"
                    tabIndex={0}
                  />
                </Tooltip>
              ) : (
                <span
                  aria-hidden="true"
                  className="size-3 border border-black/40 bg-[#101010]"
                  key={`empty-${weekIndex}-${dayIndex}`}
                />
              ),
            ),
          )}
        </div>
        <div className="mt-3 flex items-center gap-1 text-[0.7rem] font-semibold uppercase leading-none text-[#666]">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              aria-hidden="true"
              className={cn(
                "size-3 border border-black/40",
                level === 0 && "bg-[#151515]",
                level === 1 && "bg-[#133225]",
                level === 2 && "bg-[#176a4a]",
                level === 3 && "bg-[#22a06b]",
                level === 4 && "bg-[#8bdc97]",
              )}
              key={level}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}

function activityRuntime(day: ContributionDay): string {
  if (day.durationMs <= 0 && day.conversations > 0) return "unknown";
  return formatDuration(day.durationMs);
}

function activityClass(count: number, max: number): string {
  if (count <= 0) return "bg-[#151515]";
  const ratio = count / max;
  if (ratio >= 0.75) return "bg-[#8bdc97]";
  if (ratio >= 0.45) return "bg-[#22a06b]";
  if (ratio >= 0.2) return "bg-[#176a4a]";
  return "bg-[#133225]";
}
