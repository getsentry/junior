import {
  IDLE_CHANGE_DAYS,
  type CodeActivityDay,
  type CodeChangeSummaryReport,
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
import { IdleText, lastActivity } from "./codeChangeIdle";
import { HomeDayStrip } from "./HomeDayStrip";

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
  // Wait for both: a missing count would read as "all clear".
  if (code.isPending || reviewCount.isPending) return <HomeSummaryLoading />;
  if (!code.data) return null;

  const nowMs = Date.parse(code.data.generatedAt);
  const merges = weeklyMerges(code.data.activityDays);
  // Longest idle first: a PR that nobody touched needs a nudge, however old.
  const open = code.data.changes
    .filter((change) => change.state === "open")
    .sort((a, b) => lastActivity(a).localeCompare(lastActivity(b)));
  // The listed changes stop at the report's limit. The summary counts every
  // open change.
  const openCount = code.data.summary.open;
  const idleCount = code.data.summary.idle;
  const needsViewer = reviewCount.data?.needsViewer ?? 0;
  if (
    merges.thisWeek + merges.lastWeek === 0 &&
    openCount === 0 &&
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
              // Open changes first, then by last update, so the week's
              // changes fit in the report's limit.
              changes={code.data.changes}
              days={merges.days}
            />
          }
          detail={<MergeDelta {...merges} />}
          label="Merged this week"
          value={merges.thisWeek}
        />
        <SummaryCard
          detail={
            openCount === 0 ? null : idleCount > 0 ? (
              <StatusText tone="bg-rose-300">
                <span className="font-medium text-dashboard-text">
                  {idleCount}
                </span>{" "}
                idle {IDLE_CHANGE_DAYS}d+
              </StatusText>
            ) : (
              <StatusText tone="bg-emerald-300">all moving</StatusText>
            )
          }
          label="Open"
          value={openCount}
        />
        <SummaryCard
          detail={
            needsViewer > 0 ? (
              <StatusText tone="bg-amber-300">
                <Link
                  className="text-inherit underline-offset-2 hover:text-dashboard-text hover:underline"
                  to="/"
                >
                  in your Inbox
                </Link>
              </StatusText>
            ) : (
              <StatusText tone="bg-emerald-300">all clear</StatusText>
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

// A tone dot keeps the detail's count from reading as part of the big value.
function StatusText(props: { children: ReactNode; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", props.tone)}
      />
      <span>{props.children}</span>
    </span>
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
 * Open code changes, longest idle first. The label row holds the only control, a
 * sort toggle, so the list has no table header. The last row expands it.
 */
function OpenChangeList(props: {
  changes: CodeChangeSummaryReport[];
  nowMs: number;
}) {
  const [recentFirst, setRecentFirst] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sorted = recentFirst ? [...props.changes].reverse() : props.changes;
  const hidden = sorted.length - OPEN_LIMIT;
  const SortIcon = recentFirst ? ArrowUp : ArrowDown;
  return (
    <div className="grid gap-2">
      <div className="flex h-4 items-center justify-between gap-4">
        <h3 className="m-0 font-sans text-xs font-medium leading-4 text-dashboard-text-muted">
          Waiting to merge
        </h3>
        {sorted.length < 2 ? null : (
          <button
            aria-label={
              recentFirst ? "Newest activity first" : "Oldest activity first"
            }
            className={quietButtonClass}
            onClick={() => setRecentFirst(!recentFirst)}
            type="button"
          >
            {recentFirst ? "Newest" : "Oldest"}
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
          <IdleText change={change} nowMs={props.nowMs} />
        </span>
      </div>
    </li>
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
