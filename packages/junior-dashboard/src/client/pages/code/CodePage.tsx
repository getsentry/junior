import { useState } from "react";
import type { CodeOverviewReport } from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { useCodeOverviewData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageRouteLoading } from "../../components/PageRouteLoading";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { CodeActivityChart } from "./CodeActivityChart";
import { CodeChangeRow } from "./CodeChangeRow";
import {
  CodeSummaryCards,
  formatCodeCost,
  formatMergeRate,
} from "./CodeSummaryCards";
import { codeRepositoryPath } from "./codeRepositoryRoutes";

/** Render code analytics and recent code changes. */
export function CodePage() {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const query = useCodeOverviewData();
  if (!query.data && !query.error) {
    return (
      <PageRouteLoading
        description="Repositories and code changes created by Junior."
        label="Loading code activity"
        title="Code"
        variant="stats"
      />
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
      <CodeSummaryCards summary={data.summary} />
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
                        <Link
                          className="text-inherit no-underline hover:text-cyan-100"
                          to={codeRepositoryPath(repository.id)}
                        >
                          {repository.name}
                        </Link>
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
                        {repository.provider}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm whitespace-nowrap text-dashboard-text">
                      {repository.created}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm whitespace-nowrap text-dashboard-text">
                      {formatMergeRate(repository.mergeRate)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm whitespace-nowrap text-dashboard-text">
                      {formatCodeCost(repository.medianCostUsd)}
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
              <CodeChangeRow change={change} key={change.id} />
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}
