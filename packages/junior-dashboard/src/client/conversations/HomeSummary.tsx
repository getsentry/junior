import type {
  CodeActivityDay,
  CodeChangeSummaryReport,
} from "@sentry/junior/api/schema";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { useActorCodeData, useDashboardCoreData } from "../api";
import {
  contributionLevel,
  contributionLevelClass,
} from "../components/charts/contributionLevel";
import { Card } from "../components/layout/Card";
import { OutboundLink } from "../components/OutboundLink";
import { Skeleton } from "../components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTitle,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useReviewItemCountData } from "../review-desk/queries";
import { cn } from "../styles";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const OPEN_LIMIT = 3;

// Sums the last 7 UTC day buckets and the 7 before them.
function weeklyMerges(days: CodeActivityDay[]) {
  const recent = days.slice(-2 * WEEK_DAYS);
  const sum = (values: CodeActivityDay[]) =>
    values.reduce((total, day) => total + day.merged, 0);
  return {
    days: recent.slice(-WEEK_DAYS),
    lastWeek: sum(recent.slice(0, -WEEK_DAYS)),
    thisWeek: sum(recent.slice(-WEEK_DAYS)),
  };
}

/**
 * Show the viewer's week under the home composer: merges, open code changes,
 * and Review items that wait on them. Counts only code changes that Junior
 * opened in Conversations that the viewer started.
 */
export function HomeSummary() {
  const email = useDashboardCoreData().data?.me.user.email;
  const code = useActorCodeData(email);
  const reviewCount = useReviewItemCountData(Boolean(email));
  if (!email) return null;
  if (code.isPending) return <HomeSummaryLoading />;
  if (!code.data) return null;

  const nowMs = Date.parse(code.data.generatedAt);
  const merges = weeklyMerges(code.data.activityDays);
  // Oldest first: the newest change is still on the viewer's mind.
  const open = code.data.changes
    .filter((change) => change.state === "open")
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  const needsViewer = reviewCount.data?.needsViewer ?? 0;
  if (
    merges.thisWeek + merges.lastWeek === 0 &&
    open.length === 0 &&
    needsViewer === 0
  ) {
    return null;
  }

  return (
    <section aria-label="Your week" className="grid gap-8">
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard
          aside={<DayStrip days={merges.days} />}
          detail={<MergeDelta {...merges} />}
          label="Merged this week"
          value={merges.thisWeek}
        />
        <SummaryCard
          detail={
            open[0] ? (
              <>
                oldest <AgeText nowMs={nowMs} openedAt={open[0].openedAt} />
              </>
            ) : null
          }
          label="Open"
          value={open.length}
        />
        <SummaryCard
          detail={
            needsViewer > 0 ? (
              <Link
                className="text-inherit underline-offset-2 hover:text-dashboard-text hover:underline"
                to="/review"
              >
                on your Review desk
              </Link>
            ) : (
              "all clear"
            )
          }
          label="Needs you"
          value={needsViewer}
        />
      </div>
      {open.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="m-0 font-sans text-xs font-medium text-dashboard-text-muted">
            Waiting to merge
          </h3>
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {open.slice(0, OPEN_LIMIT).map((change) => (
              <OpenChangeRow change={change} key={change.id} nowMs={nowMs} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function SummaryCard(props: {
  aside?: ReactNode;
  detail: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card className="grid gap-3 px-4 py-3.5">
      <div className="flex h-4 items-center justify-between gap-3">
        <span className="truncate font-sans text-xs font-medium text-dashboard-text-muted">
          {props.label}
        </span>
        {props.aside}
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-display text-3xl font-light leading-none tracking-[-0.04em] text-dashboard-text tabular-nums">
          {props.value}
        </span>
        <span className="min-w-0 truncate font-sans text-xs text-dashboard-text-muted">
          {props.detail}
        </span>
      </div>
    </Card>
  );
}

function MergeDelta(props: { lastWeek: number; thisWeek: number }) {
  const delta = props.thisWeek - props.lastWeek;
  if (delta === 0) return <>same as last week</>;
  return (
    <>
      <span
        className={cn(
          "font-medium",
          delta > 0 ? "text-emerald-300" : "text-dashboard-text",
        )}
      >
        {delta > 0 ? `+${delta}` : `−${-delta}`}
      </span>{" "}
      vs last week
    </>
  );
}

/** One cell per day in GitHub greens. Hover shows the day's merges. */
function DayStrip(props: { days: CodeActivityDay[] }) {
  const max = Math.max(1, ...props.days.map((day) => day.merged));
  return (
    <div className="flex gap-0.5" role="list" aria-label="Merges per day">
      {props.days.map((day) => (
        <Tooltip key={day.date}>
          <TooltipTrigger
            render={
              <span
                aria-label={`${formatDay(day.date)}: ${mergeCount(day.merged)}`}
                className={cn(
                  "size-[7px] rounded-[1.5px] outline-none focus-visible:ring-2 focus-visible:ring-dashboard-focus",
                  contributionLevelClass(contributionLevel(day.merged, max)),
                )}
                role="listitem"
                tabIndex={0}
              />
            }
          />
          <TooltipContent sideOffset={6}>
            <TooltipTitle>{formatDay(day.date)}</TooltipTitle>
            <div className="text-dashboard-text">{mergeCount(day.merged)}</div>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function OpenChangeRow(props: {
  change: CodeChangeSummaryReport;
  nowMs: number;
}) {
  const change = props.change;
  const title = change.title ?? `${change.repository} #${change.number}`;
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-6 py-1.5">
      <div className="min-w-0 truncate font-sans text-sm text-dashboard-text">
        {change.url ? (
          <OutboundLink
            className="inline-flex max-w-full items-center text-inherit no-underline hover:text-dashboard-accent-text"
            href={change.url}
          >
            <span className="truncate">{title}</span>
          </OutboundLink>
        ) : (
          title
        )}
      </div>
      <div className="flex shrink-0 items-baseline gap-4 font-sans text-xs text-dashboard-text-muted tabular-nums">
        <span className="hidden sm:inline">
          {change.repository} #{change.number}
        </span>
        <span className="w-10 text-right">
          <AgeText nowMs={props.nowMs} openedAt={change.openedAt} />
        </span>
      </div>
    </li>
  );
}

/** Age of an open code change: plain up to 3 days, amber to 7, red after. */
function AgeText(props: { nowMs: number; openedAt: string }) {
  const days = Math.floor((props.nowMs - Date.parse(props.openedAt)) / DAY_MS);
  return (
    <span
      className={cn(
        days > 7 && "font-medium text-rose-300",
        days >= 4 && days <= 7 && "font-medium text-amber-300",
      )}
    >
      {days < 1 ? "today" : `${days}d`}
    </span>
  );
}

function HomeSummaryLoading() {
  return (
    <div
      aria-label="Loading your week"
      className="grid grid-cols-3 gap-3"
      role="status"
    >
      {[0, 1, 2].map((index) => (
        <Card className="grid gap-3 px-4 py-3.5" key={index}>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-7 w-28" />
        </Card>
      ))}
    </div>
  );
}

function mergeCount(count: number): string {
  return count === 1 ? "1 merge" : `${count} merges`;
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  });
}
