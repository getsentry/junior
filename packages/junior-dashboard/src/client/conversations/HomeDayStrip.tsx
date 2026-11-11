import type {
  CodeActivityDay,
  CodeRepositoryActivityDay,
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

type ActivityCounts = Pick<
  CodeRepositoryActivityDay,
  "closed" | "created" | "merged"
>;

// Column order in the tooltip. Icons match the PR states in Conversations.
const ACTIVITY_KINDS = [
  { icon: "git-merge", key: "merged", label: "merged" },
  { icon: "git-pull-request", key: "created", label: "opened" },
  { icon: "circle-x", key: "closed", label: "closed" },
] as const;

// Repository name, then one fixed count column per kind that the day has.
const COLUMN_CLASSES = [
  "grid-cols-1",
  "grid-cols-[minmax(0,1fr)_1.5rem]",
  "grid-cols-[minmax(0,1fr)_1.5rem_1.5rem]",
  "grid-cols-[minmax(0,1fr)_1.5rem_1.5rem_1.5rem]",
];

/**
 * Show one cell per day in GitHub greens, shaded by merges. Hover shows the
 * day's code changes per repository.
 */
export function HomeDayStrip(props: {
  days: CodeActivityDay[];
  repositoryDays: CodeRepositoryActivityDay[];
}) {
  const max = Math.max(1, ...props.days.map((day) => day.merged));
  return (
    <div className="flex gap-0.5" role="list" aria-label="Activity per day">
      {props.days.map((day) => {
        const repositories = props.repositoryDays
          .filter((row) => row.date === day.date)
          .sort(
            (a, b) =>
              activityTotal(b) - activityTotal(a) ||
              a.repository.localeCompare(b.repository),
          );
        const total = sumActivity(repositories);
        return (
          <Tooltip key={day.date}>
            <TooltipTrigger
              render={
                <span
                  aria-label={`${formatDay(day.date)}: ${activitySummary(total)}`}
                  className={cn(
                    "size-[7px] rounded-[1.5px] outline-none focus-visible:ring-2 focus-visible:ring-dashboard-focus",
                    contributionLevelClass(contributionLevel(day.merged, max)),
                  )}
                  role="listitem"
                  tabIndex={0}
                />
              }
            />
            <TooltipContent className="min-w-60 px-3.5 py-3" sideOffset={8}>
              <DayActivity
                date={day.date}
                repositories={repositories}
                total={total}
              />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * The header row names the day and puts a state icon over each count column,
 * so the repository rows below need no labels.
 */
function DayActivity(props: {
  date: string;
  repositories: CodeRepositoryActivityDay[];
  total: ActivityCounts;
}) {
  const kinds = ACTIVITY_KINDS.filter((kind) => props.total[kind.key] > 0);
  const columns = cn("grid items-center gap-x-3", COLUMN_CLASSES[kinds.length]);
  return (
    <div className="grid gap-3 leading-5">
      <div className={columns}>
        <div className="min-w-0">
          <div className="font-medium text-dashboard-text">
            {formatDay(props.date)}
          </div>
          <div className="text-dashboard-text-muted">
            {activitySummary(props.total)}
          </div>
        </div>
        {kinds.map((kind) => (
          <span className="flex justify-end self-start pt-1" key={kind.key}>
            <SidebarAnnotationIcon decorative icon={kind.icon} size={12} />
          </span>
        ))}
      </div>
      {props.repositories.length > 0 ? (
        <div
          className={cn(
            columns,
            "gap-y-1 border-t border-dashboard-border-subtle pt-2.5 tabular-nums",
          )}
        >
          {props.repositories.flatMap((row) => [
            <RepositoryName key={row.repository} name={row.repository} />,
            ...kinds.map((kind) => (
              <span
                className={cn(
                  "text-right",
                  row[kind.key] > 0
                    ? "font-medium text-dashboard-text"
                    : "text-dashboard-text-faint",
                )}
                key={`${row.repository}:${kind.key}`}
              >
                {row[kind.key] > 0 ? row[kind.key] : "–"}
              </span>
            )),
          ])}
        </div>
      ) : null}
    </div>
  );
}

// The owner repeats on most rows, so it steps back behind the name.
function RepositoryName(props: { name: string }) {
  const slash = props.name.lastIndexOf("/");
  return (
    <span className="min-w-0 truncate text-dashboard-text-muted">
      {slash > 0 ? (
        <span className="text-dashboard-text-faint">
          {props.name.slice(0, slash + 1)}
        </span>
      ) : null}
      {props.name.slice(slash + 1)}
    </span>
  );
}

function activityTotal(counts: ActivityCounts): number {
  return counts.closed + counts.created + counts.merged;
}

function sumActivity(rows: ActivityCounts[]): ActivityCounts {
  return rows.reduce(
    (total, row) => ({
      closed: total.closed + row.closed,
      created: total.created + row.created,
      merged: total.merged + row.merged,
    }),
    { closed: 0, created: 0, merged: 0 },
  );
}

function activitySummary(counts: ActivityCounts): string {
  const parts = ACTIVITY_KINDS.filter((kind) => counts[kind.key] > 0).map(
    (kind) => `${counts[kind.key]} ${kind.label}`,
  );
  return parts.length > 0 ? parts.join(" · ") : "No activity";
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  });
}
