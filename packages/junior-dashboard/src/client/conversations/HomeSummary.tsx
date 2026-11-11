import type {
  CodeActivityDay,
  CodeChangeSummaryReport,
} from "@sentry/junior/api/schema";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useActorCodeData, useDashboardCoreData } from "../api";
import { Card } from "../components/layout/Card";
import { Skeleton } from "../components/ui/skeleton";
import { useReviewItemCountData } from "../review-desk/queries";
import { cn } from "../styles";
import { SidebarAnnotationIcon } from "./ConversationMeta";
import { HomeDayStrip } from "./HomeDayStrip";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** Open code changes shown before the reader expands the list. */
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
  const oldest = open[0];
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
          aside={
            <HomeDayStrip
              changes={code.data.activityChanges}
              days={merges.days}
            />
          }
          detail={<MergeDelta {...merges} />}
          label="Merged this week"
          value={merges.thisWeek}
        />
        <SummaryCard
          detail={
            oldest ? (
              <>
                oldest <AgeText nowMs={nowMs} openedAt={oldest.openedAt} />
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
      {open.length > 0 ? <OpenChangeList changes={open} nowMs={nowMs} /> : null}
    </section>
  );
}

const cardClass = "grid gap-3 px-4 py-3.5";

function SummaryCard(props: {
  aside?: ReactNode;
  detail: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card className={cardClass}>
      <div className="flex h-4 items-center justify-between gap-3">
        <span className="truncate font-sans text-xs font-medium text-dashboard-text-muted">
          {props.label}
        </span>
        {props.aside}
      </div>
      <div className="flex h-7.5 min-w-0 items-baseline gap-2">
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

/**
 * Open code changes, oldest first. The label row holds the only control, a
 * sort toggle, so the list has no table header. The last row expands it.
 */
function OpenChangeList(props: {
  changes: CodeChangeSummaryReport[];
  nowMs: number;
}) {
  const [newestFirst, setNewestFirst] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sorted = newestFirst ? [...props.changes].reverse() : props.changes;
  const hidden = sorted.length - OPEN_LIMIT;
  const SortIcon = newestFirst ? ArrowUp : ArrowDown;
  return (
    <div className="grid gap-2">
      <div className="flex h-4 items-center justify-between gap-4">
        <h3 className="m-0 font-sans text-xs font-medium leading-4 text-dashboard-text-muted">
          Waiting to merge
        </h3>
        {sorted.length < 2 ? null : (
          <button
            aria-label={newestFirst ? "Newest first" : "Oldest first"}
            className={quietButtonClass}
            onClick={() => setNewestFirst(!newestFirst)}
            type="button"
          >
            {newestFirst ? "Newest" : "Oldest"}
            <SortIcon aria-hidden="true" className="size-3" />
          </button>
        )}
      </div>
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {(expanded ? sorted : sorted.slice(0, OPEN_LIMIT)).map((change) => (
          <OpenChangeRow change={change} key={change.id} nowMs={props.nowMs} />
        ))}
        {hidden > 0 ? (
          <li className={rowClass}>
            <button
              aria-expanded={expanded}
              className={quietButtonClass}
              onClick={() => setExpanded(!expanded)}
              type="button"
            >
              {expanded ? "Show less" : `${hidden} more`}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

// Fixed row height, so HomeSummaryLoading matches the list.
const rowClass = "flex h-8 min-w-0 items-center justify-between gap-6";
// List controls sit below the row text in contrast, so rows stay the focus.
const quietButtonClass =
  "inline-flex h-4 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-sans text-xs font-normal leading-4 text-dashboard-text-faint hover:text-dashboard-text-muted focus-visible:text-dashboard-text-muted";

function OpenChangeRow(props: {
  change: CodeChangeSummaryReport;
  nowMs: number;
}) {
  const change = props.change;
  const title = change.title ?? `${change.repository} #${change.number}`;
  return (
    <li className={rowClass}>
      <div className="flex min-w-0 items-center gap-2.5 font-sans text-sm text-dashboard-text">
        <SidebarAnnotationIcon decorative icon="git-pull-request" size={14} />
        {change.url ? (
          // The PR icon marks the row, so the link has no outbound icon. It
          // still opens GitHub in a new tab.
          <a
            className="min-w-0 truncate text-inherit no-underline underline-offset-2 hover:underline"
            href={change.url}
            rel="noreferrer"
            target="_blank"
          >
            {title}
          </a>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4 font-sans text-xs text-dashboard-text-muted">
        <span className="hidden sm:inline">
          {/* Tabular figures only on digits: they widen hyphens in names. */}
          {change.repository}{" "}
          <span className="tabular-nums">#{change.number}</span>
        </span>
        <span className="w-10 text-right tabular-nums">
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

/** Same frame and row heights as the loaded summary with three open rows. */
function HomeSummaryLoading() {
  return (
    <div aria-label="Loading your week" className="grid gap-8" role="status">
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((index) => (
          <Card className={cardClass} key={index}>
            <div className="flex h-4 items-center">
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="flex h-7.5 items-center">
              <Skeleton className="h-6 w-28" />
            </div>
          </Card>
        ))}
      </div>
      <div className="grid gap-2">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="grid gap-0.5">
          {["w-1/2", "w-2/5", "w-1/3"].map((width) => (
            <div className={rowClass} key={width}>
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <Skeleton className="size-3.5 shrink-0 rounded-full" />
                <Skeleton className={cn("h-3.5", width)} />
              </div>
              <Skeleton className="h-3 w-44" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
