import { useState } from "react";
import type { CodeOverviewReport } from "@sentry/junior/api/schema";
import { Coins, GitPullRequest, LibraryBig, Timer } from "lucide-react";
import { useCodeOverviewData } from "../../api";
import { formatDuration } from "../../components/Duration";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { StatusChip } from "../../components/StatusChip";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber, formatCostSummary } from "../../format";
import { CodeActivityChart } from "./CodeActivityChart";

function mergeRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function medianMergeTime(value: number | undefined): string {
  return formatDuration(value) || "—";
}

function costUsd(value: number | undefined): string {
  return formatCostSummary(value === undefined ? undefined : { total: value }) || "—";
}

function stateTone(state: "closed" | "merged" | "open") {
  if (state === "merged") return "success" as const;
  if (state === "open") return "info" as const;
  return "neutral" as const;
}

/** Render code analytics and recent code changes. */
export function CodePage() {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const query = useCodeOverviewData();
  if (!query.data && !query.error) {
    return (
      <PageLayout>
        <LoadingView label="Loading code activity" />
      </PageLayout>
    );
  }
  return (
    <PageLayout>
      <PageHeader
        description="Repositories and code changes created by Junior."
        onRangeChange={setRange}
        range={range}
        title="Code"
      />
      {query.error ? (
        <EmptyTelemetry>
          Code activity is unavailable. Try refreshing the dashboard.
        </EmptyTelemetry>
      ) : null}
      {query.data ? <CodeOverview data={query.data} range={range} /> : null}
    </PageLayout>
  );
}

function CodeOverview(props: {
  data: CodeOverviewReport;
  range: TimeRangeDays;
}) {
  const data = props.data;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          detail="In the last 30 days"
          icon={GitPullRequest}
          label="Created"
          value={formatCompactNumber(data.summary.created)}
        />
        <StatCard
          detail="Share of completed changes that merged"
          icon={LibraryBig}
          label="Merge rate"
          value={mergeRate(data.summary.mergeRate)}
        />
        <StatCard
          detail="Median time from open to merge in the last 30 days"
          icon={Timer}
          label="Median merge time"
          value={medianMergeTime(data.summary.medianMergeTimeMs)}
        />
        <StatCard
          detail="Conversation cost for changes opened in the last 30 days"
          icon={Coins}
          label="Cost"
          value={costUsd(data.summary.costUsd)}
        />
      </div>
      <CodeActivityChart
        bucketUnit={timeRangeBucketUnit(props.range)}
        days={selectTimeSeries({
          days: data.activityDays,
          hours: data.activityHours,
          sixHours: data.activitySixHours,
          range: props.range,
          emptySixHour: (date) => ({
            closed: 0,
            created: 0,
            date,
            merged: 0,
          }),
        })}
        range={props.range}
      />
      <Card as="section">
        <div className="border-b border-dashboard-border-subtle px-4 py-3 font-display text-lg text-dashboard-text">
          Repositories
        </div>
        {data.repositories.length === 0 ? (
          <div className="p-4">
            <EmptyTelemetry>
              No code activity has been recorded yet.
            </EmptyTelemetry>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] table-fixed border-collapse text-left">
              <colgroup>
                <col />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
              </colgroup>
              <thead className="font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
                <tr className="border-b border-dashboard-border-subtle">
                  <th className="px-4 py-2.5 font-medium">Repository</th>
                  <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">
                    Created
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">
                    Merge rate
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">
                    Median cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.repositories.map((repository) => (
                  <tr
                    className="border-b border-dashboard-border-subtle last:border-b-0"
                    key={repository.id}
                  >
                    <td className="min-w-0 px-4 py-3">
                      <div className="truncate font-display text-sm text-dashboard-text">
                        {repository.url ? (
                          <a
                            className="text-inherit no-underline hover:text-cyan-100"
                            href={repository.url}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {repository.name}
                          </a>
                        ) : (
                          repository.name
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
                        {repository.provider}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm whitespace-nowrap text-dashboard-text">
                      {repository.created}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm whitespace-nowrap text-dashboard-text">
                      {mergeRate(repository.mergeRate)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm whitespace-nowrap text-dashboard-text">
                      {costUsd(repository.medianCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data.changes.length > 0 ? (
        <Card as="section">
          <div className="border-b border-dashboard-border-subtle px-4 py-3 font-display text-lg text-dashboard-text">
            Recent changes
          </div>
          <div>
            {data.changes.map((change) => (
              <div
                className="flex min-w-0 items-center justify-between gap-4 border-b border-dashboard-border-subtle px-4 py-3 last:border-b-0"
                key={change.id}
              >
                <div className="min-w-0">
                  <div className="truncate font-display text-sm text-dashboard-text">
                    {change.url ? (
                      <a
                        className="text-inherit no-underline hover:text-cyan-100"
                        href={change.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {change.title ??
                          `${change.repository} #${change.number}`}
                      </a>
                    ) : (
                      (change.title ?? `${change.repository} #${change.number}`)
                    )}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
                    {change.repository} #{change.number} · {change.provider}
                  </div>
                </div>
                <StatusChip size="compact" tone={stateTone(change.state)}>
                  {change.state}
                </StatusChip>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}
