import type {
  CodeActivityDay,
  CodeChangeSummaryReport,
} from "@sentry/junior/api/schema";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { useActorCodeData, useDashboardCoreData } from "../api";
import { Card } from "../components/layout/Card";
import { OutboundLink } from "../components/OutboundLink";
import { Skeleton } from "../components/ui/skeleton";
import { useReviewItemCountData } from "../review-desk/queries";
import { cn } from "../styles";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** An open code change older than this reads as stale. */
const STALE_DAYS = 7;
const OPEN_LIMIT = 3;

// Sums the last 7 UTC day buckets and the 7 before them.
function weeklyMerges(days: CodeActivityDay[]) {
  const merged = days.slice(-2 * WEEK_DAYS).map((day) => day.merged);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    days: merged.slice(-WEEK_DAYS),
    lastWeek: sum(merged.slice(0, -WEEK_DAYS)),
    thisWeek: sum(merged.slice(-WEEK_DAYS)),
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
    <section aria-label="Your week" className="grid gap-6 pt-6">
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard
          detail={<MergeDelta {...merges} />}
          label="Merged this week"
          value={merges.thisWeek}
        >
          <DayStrip days={merges.days} />
        </SummaryCard>
        <SummaryCard
          detail={
            open[0] ? `Oldest ${formatAge(open[0].openedAt, nowMs)}` : "None"
          }
          label="Open"
          value={open.length}
        />
        <SummaryCard
          detail={
            needsViewer > 0 ? (
              <Link
                className="text-inherit no-underline hover:text-dashboard-accent-text"
                to="/review"
              >
                On your Review desk
              </Link>
            ) : (
              "All clear"
            )
          }
          label="Needs you"
          value={needsViewer}
        />
      </div>
      {open.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="m-0 px-1 font-sans text-xs font-medium text-dashboard-text-muted">
            Waiting to merge
          </h3>
          <ul className="m-0 grid list-none p-0">
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
  children?: ReactNode;
  detail: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card className="grid gap-1 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="font-display text-2xl font-light leading-none tracking-[-0.03em] text-dashboard-text">
          {props.value}
        </div>
        {props.children}
      </div>
      <div className="mt-2 truncate font-sans text-xs font-medium text-dashboard-text">
        {props.label}
      </div>
      <div className="truncate font-sans text-xs text-dashboard-text-muted">
        {props.detail}
      </div>
    </Card>
  );
}

function MergeDelta(props: { lastWeek: number; thisWeek: number }) {
  const delta = props.thisWeek - props.lastWeek;
  if (delta === 0) return <>Same as last week</>;
  return (
    <>
      <span className={cn(delta > 0 && "text-emerald-300")}>
        {delta > 0 ? `+${delta}` : `−${-delta}`}
      </span>{" "}
      vs last week
    </>
  );
}

/** One square per day, brighter with more merges. */
function DayStrip(props: { days: number[] }) {
  const max = Math.max(1, ...props.days);
  return (
    <div aria-hidden="true" className="flex gap-0.5 pt-1">
      {props.days.map((count, index) => (
        <span
          className={cn(
            "size-1.5 rounded-[1px]",
            count === 0 ? "bg-dashboard-border" : "bg-amber-400",
          )}
          key={index}
          style={
            count === 0 ? undefined : { opacity: 0.4 + (0.6 * count) / max }
          }
        />
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
  const stale = ageDays(change.openedAt, props.nowMs) >= STALE_DAYS;
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-4 rounded-md px-1 py-1.5">
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
      <div className="flex shrink-0 items-baseline gap-3 font-mono text-xs text-dashboard-text-muted">
        <span className="hidden sm:inline">
          {change.repository} #{change.number}
        </span>
        <span
          className={cn("w-8 text-right", stale && "text-amber-300")}
          title={stale ? "Open for a week or more" : undefined}
        >
          {formatAge(change.openedAt, props.nowMs)}
        </span>
      </div>
    </li>
  );
}

function HomeSummaryLoading() {
  return (
    <div
      aria-label="Loading your week"
      className="grid grid-cols-3 gap-3 pt-6"
      role="status"
    >
      {[0, 1, 2].map((index) => (
        <Card className="grid gap-2 p-4" key={index}>
          <Skeleton className="h-6 w-8" />
          <Skeleton className="mt-1 h-3 w-20" />
          <Skeleton className="h-3 w-24" />
        </Card>
      ))}
    </div>
  );
}

function ageDays(openedAt: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(openedAt)) / DAY_MS);
}

function formatAge(openedAt: string, nowMs: number): string {
  const days = ageDays(openedAt, nowMs);
  return days < 1 ? "today" : `${days}d`;
}
