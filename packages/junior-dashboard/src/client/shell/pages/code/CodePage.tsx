import { type ReactNode, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router";

import { useCodeOverviewData, useDashboardCoreData } from "../../../api";
import { EmptyTelemetry } from "../../../components/EmptyTelemetry";
import { InlineError } from "../../../components/InlineError";
import { PageContentSkeleton } from "../../../components/PageContentSkeleton";
import {
  timeRangeBucketUnit,
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../../components/controls/TimeRangeSelector";
import { getDashboardAgentName } from "../../../agentName";
import { useInboxData } from "../../../inbox/inboxData";
import { inboxViewPath, viewRows } from "../../../inbox/inboxModel";
import {
  PullRequestChange,
  type PullRequestChangeRow,
  PullRequestStack,
  stackedChanges,
  usePullRequestSections,
} from "../../../inbox/InboxPullRequests";
import { InboxEmptyState, InboxSection } from "../../../inbox/InboxSection";
import { RetryRow } from "../../../inbox/PageEnd";
import type { InboxBundle } from "../../../inbox/inboxItemFormat";
import { inboxCardClass } from "../../../inbox/inboxRowStyles";
import { cn } from "../../../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../../textFade";
import { CodeActivityChart } from "../../../pages/code/CodeActivityChart";
import {
  CodeRecentChanges,
  CodeRepositoriesCard,
} from "../../../pages/code/CodePage";
import { CodeSummaryCards } from "../../../pages/code/CodeSummaryCards";
import { codeActivity } from "../../../pages/code/RepositorySections";
import { codeScopeOf } from "../../../pages/code/codeRepositoryRoutes";
import type { CodeOverviewReport } from "@sentry/junior/api/schema";
import { CodePageFrame } from "./CodePageFrame";
import { CodeScopeTabs } from "./CodeScopeTabs";

/**
 * Code: on Mine, the viewer's open pull requests and their numbers; on All,
 * every repository and the numbers of all code changes. Signed out, Code
 * shows All.
 */
export function CodePage() {
  const location = useLocation();
  const [params] = useSearchParams();
  const signedIn = Boolean(useDashboardCoreData().data?.me.user.email);
  const scope = signedIn ? codeScopeOf(params) : "all";
  const [range, setRange] = useState<TimeRangeDays>(30);
  const rangeSelector = <TimeRangeSelector onChange={setRange} value={range} />;
  return (
    <CodePageFrame
      returnPath={`${location.pathname}${location.search}`}
      tabs={
        signedIn ? (
          <CodeScopeTabs scope={scope} search={location.search} />
        ) : undefined
      }
      title="Code"
    >
      {scope === "mine" ? (
        <CodeMine range={range} rangeSelector={rangeSelector} />
      ) : (
        <CodeAll range={range} rangeSelector={rangeSelector} />
      )}
    </CodePageFrame>
  );
}

/**
 * The viewer's open pull requests: Waiting on you, Waiting on others, and
 * Drafts, each with the Inbox asks that name it. Their numbers follow.
 */
function CodeMine(props: { range: TimeRangeDays; rangeSelector: ReactNode }) {
  const data = useInboxData();
  const pullRequests = usePullRequestSections(
    viewRows(data.awake, "prs"),
    data.itemPages,
    true,
  );
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Each change's group depends on its asks, so both load first.
  if (data.itemsError)
    return (
      <InlineError className="py-3">Could not load your asks.</InlineError>
    );
  if (pullRequests.loading || !data.itemsLoaded)
    return (
      <PageContentSkeleton label="Loading your pull requests" variant="list" />
    );
  const report = pullRequests.report;
  const changeRow = (row: PullRequestChangeRow) => (
    <PullRequestChange
      expanded={false}
      key={row.change.id}
      nowMs={pullRequests.nowMs}
      row={row}
    >
      {row.items.length > 0
        ? row.items.map((item) => <AskRow item={item} key={item.key} nested />)
        : null}
    </PullRequestChange>
  );
  return (
    <>
      <div>
        {pullRequests.sections.length === 0 ? (
          <InboxEmptyState label="No open pull requests" />
        ) : (
          pullRequests.sections.map((section) => (
            <InboxSection
              collapsed={
                toggled.has(section.key) !== Boolean(section.collapsedByDefault)
              }
              count={section.changes.length + section.items.length}
              key={section.key}
              label={section.label}
              onToggle={() => toggle(section.key)}
            >
              {stackedChanges(section.changes).map((entry) =>
                entry.kind === "stack" ? (
                  <PullRequestStack
                    count={entry.rows.length}
                    key={entry.key}
                    stack={entry.stack}
                  >
                    {entry.rows.map(changeRow)}
                  </PullRequestStack>
                ) : (
                  changeRow(entry.row)
                ),
              )}
              {section.items.map((item) => (
                <AskRow item={item} key={item.key} />
              ))}
            </InboxSection>
          ))
        )}
      </div>
      {data.itemPages.failed ? (
        <RetryRow
          loading={data.itemPages.loadingMore}
          onRetry={data.itemPages.retry}
        >
          Could not load more.
        </RetryRow>
      ) : null}
      {pullRequests.error ? (
        <EmptyTelemetry>
          Your code activity is unavailable. Try refreshing the dashboard.
        </EmptyTelemetry>
      ) : report ? (
        <CodeNumbers
          range={props.range}
          rangeSelector={props.rangeSelector}
          report={report}
        />
      ) : null}
    </>
  );
}

/**
 * One Inbox ask about a pull request, which opens its row in the Inbox,
 * where the viewer acts on it. Under its change it names only the ask; on
 * its own it names the pull request too.
 */
function AskRow(props: { item: InboxBundle; nested?: boolean }) {
  const item = props.item.newest;
  const subject = props.nested ? undefined : item.subject?.title;
  return (
    <li aria-label={subject ?? item.title} className="min-w-0 list-none">
      <Link
        className={cn(
          inboxCardClass(false),
          "flex min-w-0 items-center gap-2.5 font-sans text-dashboard-text no-underline",
          props.nested ? "px-3 py-1.5 text-sm" : "px-4 py-2.5",
        )}
        to={inboxViewPath("inbox", { itemId: item.id })}
      >
        {props.item.needsYou ? (
          // Its section already says that it waits on the viewer.
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-dashboard-accent"
          />
        ) : null}
        {/* A phone puts the ask under its pull request, as a change row
            puts its numbers. */}
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2.5">
          <span
            className={cn(
              fadeOverflowClass,
              subject && "font-display text-base font-medium",
            )}
            ref={fadeWhenOverflowing}
          >
            {subject ?? item.title}
          </span>
          {subject ? (
            <span className="shrink-0 text-xs text-dashboard-text-muted sm:ml-auto">
              {item.title}
            </span>
          ) : null}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="shrink-0 text-dashboard-text-muted"
          size={14}
        />
      </Link>
    </li>
  );
}

/**
 * Every repository, then the numbers and activity of all code changes, and
 * the newest changes.
 */
function CodeAll(props: { range: TimeRangeDays; rangeSelector: ReactNode }) {
  const query = useCodeOverviewData();
  if (query.error)
    return (
      <EmptyTelemetry>
        Code activity is unavailable. Try refreshing the dashboard.
      </EmptyTelemetry>
    );
  if (!query.data)
    return (
      <PageContentSkeleton label="Loading code activity" variant="stats" />
    );
  return (
    <>
      <p className="m-0 font-sans text-sm text-dashboard-text-muted">
        Repositories and code changes created by {getDashboardAgentName()}.
      </p>
      <CodeRepositoriesCard repositories={query.data.repositories} />
      <CodeNumbers
        range={props.range}
        rangeSelector={props.rangeSelector}
        report={query.data}
      />
      <CodeRecentChanges changes={query.data.changes} />
    </>
  );
}

/** The 30-day summary cards, then the activity chart with its range. */
function CodeNumbers(props: {
  range: TimeRangeDays;
  rangeSelector: ReactNode;
  report: Pick<
    CodeOverviewReport,
    "activityDays" | "activityHours" | "activitySixHours" | "summary"
  >;
}) {
  return (
    <>
      <CodeSummaryCards summary={props.report.summary} />
      <CodeActivityChart
        actions={props.rangeSelector}
        bucketUnit={timeRangeBucketUnit(props.range)}
        days={codeActivity(props.report, props.range)}
        range={props.range}
      />
    </>
  );
}
