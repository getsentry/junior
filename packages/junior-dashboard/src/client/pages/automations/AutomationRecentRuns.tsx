import type { AutomationSummary } from "@sentry/junior/api/schema";
import { Link } from "react-router";

import { useAutomationExecutionsData } from "../../api";
import { Button } from "../../components/ui/button";
import { InlineError } from "../../components/InlineError";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusChip } from "../../components/StatusChip";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  automationPath,
  formatCostSummary,
  formatRelativeTime,
  formatRuntime,
} from "../../format";
import { dashboardInlineLinkClass } from "../../styles";
import { formatAutomationRunTime } from "./automationFormat";

/** Preview the newest terminal runs on the Automation overview. */
export function AutomationRecentRuns({
  automation,
}: {
  automation: AutomationSummary;
}) {
  const query = useAutomationExecutionsData(true, automation.id);
  const runs = query.data?.executions.slice(0, 3) ?? [];
  return (
    <section aria-label="Recent runs" className="grid min-w-0 gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
          Recent runs
        </h3>
        {automation.totalRuns > 0 || runs.length > 0 ? (
          <Link
            className={`${dashboardInlineLinkClass} text-xs`}
            to={automationPath(automation.id, "runs")}
          >
            View all runs
          </Link>
        ) : null}
      </div>
      {query.isPending ? (
        <div aria-busy="true" role="status" className="grid gap-2">
          <span className="sr-only">Loading recent runs</span>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton className="h-14 rounded-md" key={index} />
          ))}
        </div>
      ) : null}
      {query.error ? (
        <InlineError>
          Recent runs could not be loaded.{" "}
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </InlineError>
      ) : null}
      {query.data && runs.length === 0 ? (
        <p className="m-0 text-sm text-dashboard-text-muted">
          {automation.totalRuns === 0
            ? "No runs yet. Results will appear here after the first run."
            : "No recent runs are available. Older run details may have expired."}
        </p>
      ) : null}
      {runs.length > 0 ? (
        <ol className="m-0 list-none divide-y divide-dashboard-border-subtle p-0">
          {runs.map((run) => {
            const metrics = [
              run.durationMs !== undefined
                ? formatRuntime(run.durationMs)
                : undefined,
              run.costUsd !== undefined
                ? formatCostSummary({ total: run.costUsd })
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ");
            const title =
              run.title !== automation.title ? run.title : undefined;
            const content = (
              <>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <StatusChip
                    size="compact"
                    tone={
                      run.status === "completed"
                        ? "success"
                        : run.status === "failed"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {run.status}
                  </StatusChip>
                  <time
                    className="text-xs text-dashboard-text-muted"
                    dateTime={run.executedAt}
                    title={formatAutomationRunTime(run.executedAt)}
                  >
                    {formatRelativeTime(run.executedAt)}
                  </time>
                </div>
                {title || metrics ? (
                  <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs text-dashboard-text-muted">
                    {title ? (
                      <p
                        className="m-0 min-w-0 truncate text-dashboard-text"
                        title={title}
                      >
                        {title}
                      </p>
                    ) : null}
                    {metrics ? (
                      <p className="m-0 shrink-0 tabular-nums">{metrics}</p>
                    ) : null}
                  </div>
                ) : null}
                {!run.conversationId ? (
                  <p className="m-0 text-xs text-dashboard-text-muted">
                    No Conversation recorded
                  </p>
                ) : null}
              </>
            );
            const rowClass = "grid min-w-0 gap-1 rounded-md px-2 py-2.5";
            return (
              <li key={run.executionId}>
                {run.conversationId ? (
                  <Link
                    aria-label={`Open ${run.status} run from ${formatAutomationRunTime(run.executedAt)}`}
                    className={`${rowClass} text-inherit no-underline transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:outline-dashboard-focus`}
                    to={conversationPath(run.conversationId)}
                  >
                    {content}
                  </Link>
                ) : (
                  <div className={rowClass}>{content}</div>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
