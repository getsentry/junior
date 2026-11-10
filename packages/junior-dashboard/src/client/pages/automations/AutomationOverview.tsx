/**
 * Read view of one Automation. Runs lead, because most visits ask "did it
 * work"; the definition sits beside them, so the cause of a failure and the
 * setting that fixes it are on one screen.
 */
import type { ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import { Link, useLocation } from "react-router";
import type {
  AutomationExecution,
  AutomationSummary,
} from "@sentry/junior/api/schema";

import {
  useAutomationExecutionsData,
  useAutomationVersionsData,
} from "../../api";
import { ActorAvatar } from "../../components/ActorAvatar";
import { Fact, FactList, FactSection } from "../../components/FactSection";
import { InlineError } from "../../components/InlineError";
import { StatusDot } from "../../components/StatusDot";
import { Card } from "../../components/layout/Card";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { conversationPath } from "../../conversations/conversationRoutes";
import { DisplayText } from "../../display-text/DisplayText";
import {
  automationPath,
  formatCostSummary,
  formatRelativeTime,
  formatRuntime,
  peoplePath,
} from "../../format";
import { pathWithSearch } from "../../searchParams";
import { dashboardInlineLinkClass } from "../../styles";
import { AutomationCost } from "./AutomationCost";
import { AutomationOutcomeList } from "./AutomationOutcomeFields";
import { AUTOMATION_RUN_PARAM } from "./AutomationRunDetails";
import { AutomationRunStrip } from "./AutomationRunStrip";
import { AutomationAttention } from "./AutomationStatus";
import {
  automationRunStatusTone,
  automationScheduleLabel,
  formatAutomationRunTime,
} from "./automationFormat";

const STRIP_RUNS = 48;
const LISTED_RUNS = 6;

/** Runs and problems on the left; what the Automation does on the right. */
export function AutomationOverview(props: {
  automation: AutomationSummary;
  editPath: string;
}) {
  const { automation } = props;
  const executions = useAutomationExecutionsData(true, automation.id);
  const latest = executions.data?.executions[0];
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
      <div className="grid min-w-0 content-start gap-4">
        <AutomationAttention
          automation={automation}
          editPath={props.editPath}
          lastRunError={
            latest && latest.status !== "completed" ? latest.error : undefined
          }
        />
        <AutomationActivity automation={automation} query={executions} />
      </div>
      <aside
        aria-label="Automation details"
        className="grid min-w-0 content-start gap-3"
      >
        <AutomationDefinition automation={automation} />
        <AutomationCost
          automation={automation}
          days={executions.data?.executionDays}
        />
        <AutomationAbout automation={automation} />
      </aside>
    </div>
  );
}

/** Recent results as a strip and a short list, with what happens next. */
function AutomationActivity(props: {
  automation: AutomationSummary;
  query: ReturnType<typeof useAutomationExecutionsData>;
}) {
  const { automation, query } = props;
  const location = useLocation();
  const runPath = (run: AutomationExecution) => {
    const search = new URLSearchParams(location.search);
    search.set(AUTOMATION_RUN_PARAM, run.executionId);
    return pathWithSearch(automationPath(automation.id, "runs"), search);
  };
  const runs = query.data?.executions ?? [];
  return (
    <section aria-label="Recent runs" className="min-w-0">
      <Card>
        <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
          <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
            Recent runs
          </h3>
          {runs.length > 0 ? (
            <Link
              className={`${dashboardInlineLinkClass} text-xs`}
              to={pathWithSearch(
                automationPath(automation.id, "runs"),
                location.search,
              )}
            >
              View all runs
            </Link>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-3 px-4 pt-3 pb-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          {query.isPending ? (
            <Skeleton className="h-16 w-full max-w-md rounded-md" />
          ) : (
            <AutomationRunStrip
              label={`Last ${Math.min(runs.length, STRIP_RUNS)} runs`}
              runs={runs
                .slice(0, STRIP_RUNS)
                .reverse()
                .map((run) => ({
                  ...run,
                  key: run.executionId,
                  to: runPath(run),
                }))}
              size="default"
              slots={STRIP_RUNS}
            />
          )}
          <AutomationNext automation={automation} />
        </div>
        {query.error ? (
          <div className="px-4 pb-4">
            <InlineError>
              Recent runs could not be loaded.{" "}
              <Button onClick={() => void query.refetch()}>Try again</Button>
            </InlineError>
          </div>
        ) : null}
        {query.data && runs.length === 0 ? (
          <p className="m-0 border-t border-dashboard-border-subtle px-4 py-4 text-sm text-dashboard-text-muted">
            {automation.totalRuns === 0
              ? "No runs yet. Results will appear here after the first run."
              : "No recent runs are available. Older run details may have expired."}
          </p>
        ) : null}
        {runs.length > 0 ? (
          <ol className="m-0 list-none border-t border-dashboard-border-subtle p-0">
            {runs.slice(0, LISTED_RUNS).map((run) => (
              <AutomationRunLine
                automation={automation}
                key={run.executionId}
                run={run}
                to={runPath(run)}
              />
            ))}
          </ol>
        ) : null}
      </Card>
    </section>
  );
}

/** One run: when, what went wrong if anything, and what it cost. */
function AutomationRunLine(props: {
  automation: AutomationSummary;
  run: AutomationExecution;
  to: string;
}) {
  const { run } = props;
  const metrics = [
    run.durationMs !== undefined ? formatRuntime(run.durationMs) : undefined,
    run.costUsd !== undefined
      ? formatCostSummary({ total: run.costUsd })
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  // The Automation title repeats on every run. Show only a different one.
  const title =
    run.title && run.title !== props.automation.title ? run.title : undefined;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_2.25rem] items-center gap-x-4 border-t border-dashboard-border-subtle pl-4 first:border-t-0">
      <Link
        aria-label={`Open ${run.status} run from ${formatAutomationRunTime(run.executedAt)}`}
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 py-2.5 text-xs text-inherit no-underline focus-visible:outline-2 focus-visible:outline-dashboard-focus sm:grid-cols-[auto_8rem_minmax(0,1fr)]"
        to={props.to}
      >
        <StatusDot
          className="self-center"
          label={run.status}
          tone={automationRunStatusTone(run.status)}
        />
        <time
          className="truncate text-dashboard-text"
          dateTime={run.executedAt}
          title={formatAutomationRunTime(run.executedAt)}
        >
          {formatRelativeTime(run.executedAt)}
        </time>
        {run.error ? (
          <span
            className="col-start-2 line-clamp-2 text-rose-300 sm:col-start-auto sm:truncate"
            title={run.error}
          >
            {run.error}
          </span>
        ) : run.status === "blocked" ? (
          // A blocked run without a reason still needs a word; the dot alone is easy to miss.
          <span className="col-start-2 truncate text-amber-300 sm:col-start-auto">
            Blocked
          </span>
        ) : (
          <span className="col-start-2 truncate text-dashboard-text-muted sm:col-start-auto">
            {title}
          </span>
        )}
      </Link>
      <span className="text-right text-xs tabular-nums text-dashboard-text-muted">
        {metrics}
      </span>
      {run.conversationId ? (
        <Link
          aria-label="Open conversation"
          className="grid size-9 place-items-center rounded-md text-dashboard-text-muted hover:bg-dashboard-fill-strong hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          title="Open conversation"
          to={conversationPath(run.conversationId)}
        >
          <MessageSquareText aria-hidden="true" size={15} />
        </Link>
      ) : (
        <span />
      )}
    </li>
  );
}

/** What runs next, at the end of the strip. */
function AutomationNext({ automation }: { automation: AutomationSummary }) {
  let label: string;
  let detail: ReactNode;
  if (automation.status === "paused") {
    label = "Paused";
    detail = "No runs until resumed";
  } else if (automation.status === "completed") {
    label = "Completed";
    detail = "No future runs";
  } else if (automation.status === "blocked") {
    label = "Blocked";
    detail = "New runs wait for a fix";
  } else if (automation.kind === "scheduled") {
    label = automation.nextRunAt
      ? `Next ${formatRelativeTime(automation.nextRunAt)}`
      : "No next run";
    detail = automation.nextRunAt
      ? formatAutomationRunTime(automation.nextRunAt, automation.timezone)
      : undefined;
  } else if (automation.trigger.problems.length > 0) {
    label = "Not listening";
    detail = "Trigger unavailable";
  } else {
    label = "Listening";
    detail = automation.trigger.events.join(", ");
  }
  return (
    <div className="grid min-w-0 shrink-0 gap-1 sm:justify-items-end sm:text-right">
      <span className="text-sm text-dashboard-text">{label}</span>
      {detail ? (
        <span className="max-w-56 truncate text-xs text-dashboard-text-muted">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/** The saved definition in reading order: what, when, where, as whom. */
function AutomationDefinition(props: { automation: AutomationSummary }) {
  const { automation } = props;
  const creator = automation.ownedByViewer ? "you" : automation.createdBy;
  const { task } = automation;
  const written = task.kind === "skill" ? task.context : task.instruction;
  return (
    <FactSection title="Definition">
      {task.kind === "skill" ? (
        <p className="m-0 text-sm text-dashboard-text-muted">
          Runs the{" "}
          <span className="font-mono text-dashboard-text">{task.skill}</span>{" "}
          skill{task.context ? " with this context:" : "."}
        </p>
      ) : null}
      {written ? (
        <div className="text-sm leading-relaxed text-dashboard-text [overflow-wrap:anywhere]">
          <DisplayText mentions={automation.mentions ?? []} text={written} />
        </div>
      ) : null}
      <div className="border-t border-dashboard-border-subtle pt-2.5">
        <FactList>
          {automation.kind === "scheduled" ? (
            <Fact label="When">{automationScheduleLabel(automation)}</Fact>
          ) : (
            <>
              <Fact label="When">{automation.trigger.events.join(", ")}</Fact>
              <Fact label="Resource">{automation.resource}</Fact>
              {automation.trigger.filters.map((filter) => (
                <Fact key={filter} label="Filter">
                  {filter}
                </Fact>
              ))}
            </>
          )}
          <Fact label="Posts to">
            {automation.outcomes.length ? (
              <AutomationOutcomeList
                destination={automation.destination}
                outcomes={automation.outcomes}
              />
            ) : (
              automation.destination.label
            )}
          </Fact>
          <Fact label="Accounts">
            {automation.credentialMode === "creator"
              ? `Connected by ${creator}`
              : "Junior’s only"}
          </Fact>
        </FactList>
      </div>
    </FactSection>
  );
}

/** Ownership and history, below the definition. */
function AutomationAbout({ automation }: { automation: AutomationSummary }) {
  const location = useLocation();
  const versions = useAutomationVersionsData(true, automation.id);
  const activeVersion = versions.data?.activeVersion;
  const creator = (
    <span className="inline-flex items-center gap-2">
      <ActorAvatar
        imageUrl={automation.createdByAvatarUrl}
        name={automation.createdBy}
        size="list"
      />
      {automation.ownedByViewer ? "You" : automation.createdBy}
    </span>
  );
  return (
    <FactSection title="About">
      <FactList>
        <Fact label="Created by">
          {automation.createdByEmail ? (
            <Link
              className="text-inherit no-underline hover:underline"
              to={peoplePath(automation.createdByEmail)}
            >
              {creator}
            </Link>
          ) : (
            creator
          )}
        </Fact>
        <Fact label="Created">
          {formatAutomationRunTime(automation.createdAt)}
        </Fact>
        <Fact label="Version">
          <Link
            className={dashboardInlineLinkClass}
            to={pathWithSearch(
              automationPath(automation.id, "versions"),
              location.search,
            )}
          >
            {activeVersion ? `Version ${activeVersion}` : "History"}
          </Link>
        </Fact>
      </FactList>
      {automation.ownedByViewer ? null : (
        <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
          {automation.destination.visibility === "private"
            ? null
            : "You can edit, pause, or delete it because it is in a public channel. "}
          Only {automation.createdBy} can turn on their connected accounts, or
          resume or run it while it uses them.
        </p>
      )}
    </FactSection>
  );
}
