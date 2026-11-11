import type {
  CodeActivityDay,
  CodeChangeSummaryReport,
} from "@sentry/junior/api/schema";

import {
  contributionLevel,
  contributionLevelClass,
} from "../components/charts/contributionLevel";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../styles";
import { SidebarAnnotationIcon } from "./ConversationMeta";

// Section order in the tooltip. Icons match the PR states in Conversations.
const ACTIVITY_KINDS = [
  { icon: "git-merge", kind: "merged", label: "Merged" },
  { icon: "git-pull-request", kind: "opened", label: "Opened" },
  { icon: "circle-x", kind: "closed", label: "Closed" },
] as const;

type ActivityKind = (typeof ACTIVITY_KINDS)[number]["kind"];
type ActivityEvent = {
  at: string;
  change: CodeChangeSummaryReport;
  kind: ActivityKind;
};

/** PRs named per section before the rest fold into "+N more". */
const SECTION_LIMIT = 3;

/**
 * Show one cell per day in GitHub greens, shaded by merges. Hover names the
 * PRs merged, opened, and closed that day.
 */
export function HomeDayStrip(props: {
  changes: CodeChangeSummaryReport[];
  days: CodeActivityDay[];
}) {
  const max = Math.max(1, ...props.days.map((day) => day.merged));
  const eventsByDay = groupByDay(props.changes.flatMap(changeEvents));
  return (
    <div className="flex gap-0.5" role="list" aria-label="Activity per day">
      {props.days.map((day) => {
        const events = eventsByDay.get(day.date) ?? [];
        return (
          <Tooltip key={day.date}>
            <TooltipTrigger
              render={
                <span
                  aria-label={`${formatDay(day.date)}: ${activitySummary(events)}`}
                  className={cn(
                    "size-[7px] rounded-[1.5px] outline-none focus-visible:ring-2 focus-visible:ring-dashboard-focus",
                    contributionLevelClass(contributionLevel(day.merged, max)),
                  )}
                  role="listitem"
                  tabIndex={0}
                />
              }
            />
            <TooltipContent className="w-80 p-0 leading-5" sideOffset={8}>
              <DayActivity date={day.date} events={events} />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// Three tiers: section label, then PR title, then repository and number.
function DayActivity(props: { date: string; events: ActivityEvent[] }) {
  const sections = ACTIVITY_KINDS.map((kind) => ({
    ...kind,
    events: props.events.filter((event) => event.kind === kind.kind),
  })).filter((section) => section.events.length > 0);
  return (
    <>
      <div className="px-3.5 py-2.5">
        <div className="font-medium text-dashboard-text">
          {formatDay(props.date)}
        </div>
        {sections.length === 0 ? (
          <div className="text-dashboard-text-muted">No PR activity</div>
        ) : null}
      </div>
      {sections.length > 0 ? (
        <div className="grid gap-3 border-t border-dashboard-border-subtle px-3.5 pt-2.5 pb-3">
          {sections.map((section) => (
            <div className="grid gap-0.5" key={section.kind}>
              <div className="flex items-center gap-2">
                <SidebarAnnotationIcon
                  decorative
                  icon={section.icon}
                  size={12}
                />
                <span className="font-medium text-dashboard-text">
                  {section.label}
                </span>
                <span className="text-dashboard-text-faint tabular-nums">
                  {section.events.length}
                </span>
              </div>
              {/* pl-5 lines titles up with the label text after the icon. */}
              <ul className="m-0 grid list-none p-0 pl-5">
                {section.events.slice(0, SECTION_LIMIT).map((event) => (
                  <li
                    className="flex min-w-0 items-baseline justify-between gap-3"
                    key={event.change.id}
                  >
                    <span className="min-w-0 truncate text-dashboard-text-muted">
                      {event.change.title ?? `#${event.change.number}`}
                    </span>
                    <span className="shrink-0 text-dashboard-text-faint">
                      {repositoryName(event.change.repository)}{" "}
                      <span className="tabular-nums">
                        #{event.change.number}
                      </span>
                    </span>
                  </li>
                ))}
                {section.events.length > SECTION_LIMIT ? (
                  <li className="text-dashboard-text-faint">
                    +{section.events.length - SECTION_LIMIT} more
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function changeEvents(change: CodeChangeSummaryReport): ActivityEvent[] {
  const events: ActivityEvent[] = [
    { at: change.openedAt, change, kind: "opened" },
  ];
  if (change.mergedAt) {
    events.push({ at: change.mergedAt, change, kind: "merged" });
  }
  if (change.state === "closed" && change.closedAt) {
    events.push({ at: change.closedAt, change, kind: "closed" });
  }
  return events;
}

// ISO timestamps are UTC, so the first 10 characters are the UTC day bucket.
function groupByDay(events: ActivityEvent[]) {
  const byDay = new Map<string, ActivityEvent[]>();
  for (const event of [...events].sort((a, b) => b.at.localeCompare(a.at))) {
    const day = event.at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  return byDay;
}

function activitySummary(events: ActivityEvent[]): string {
  const parts = ACTIVITY_KINDS.map((kind) => ({
    count: events.filter((event) => event.kind === kind.kind).length,
    kind: kind.kind,
  }))
    .filter((part) => part.count > 0)
    .map((part) => `${part.count} ${part.kind}`);
  return parts.length > 0 ? parts.join(", ") : "No PR activity";
}

// The owner repeats on most rows; the full name is on the list below.
function repositoryName(repository: string): string {
  return repository.slice(repository.lastIndexOf("/") + 1);
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  });
}
