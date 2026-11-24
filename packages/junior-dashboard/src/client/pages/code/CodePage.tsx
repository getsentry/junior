import { useState } from "react";
import type { CodeOverviewReport } from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { useCodeOverviewData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageRouteLoading } from "../../components/PageRouteLoading";
import {
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { CodeActivityChart } from "./CodeActivityChart";
import { CodeChangeRows } from "./CodeChangeRow";
import {
  CodeSummaryCards,
  formatCodeCost,
  formatMergeRate,
} from "./CodeSummaryCards";
import { codeRepositoryPath } from "./codeRepositoryRoutes";
import { codeActivity } from "./RepositorySections";
import { getDashboardAgentName } from "../../agentName";

/** Render code analytics and recent code changes. */
export function CodePage() {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const query = useCodeOverviewData();
  if (!query.data && !query.error) {
    return (
      <PageRouteLoading
        description={`Repositories and code changes created by ${getDashboardAgentName()}.`}
        label="Loading code activity"
        title="Code"
        variant="stats"
      />
    );
  }
  return (
    <PageLayout>
      <PageHeader
        description={`Repositories and code changes created by ${getDashboardAgentName()}.`}
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
        days={codeActivity(data, props.range)}
        range={props.range}
      />
      <CodeRepositoriesCard repositories={data.repositories} />
      <CodeRecentChanges changes={data.changes} />
    </>
  );
}

/** Every repository with code changes, with its numbers. */
export function CodeRepositoriesCard(props: {
  repositories: CodeOverviewReport["repositories"];
}) {
  return (
    <Card as="section">
      <div className="border-b border-dashboard-border-subtle px-4 py-3 font-display text-lg text-dashboard-text">
        Repositories
      </div>
      {props.repositories.length === 0 ? (
        <div className="p-4">
          <EmptyTelemetry>
            No code activity has been recorded yet.
          </EmptyTelemetry>
        </div>
      ) : (
        <Table className="min-w-[36rem] table-fixed">
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-28" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Repository</TableHead>
              <TableHead className="px-4 text-right">Created</TableHead>
              <TableHead className="px-4 text-right">Merge rate</TableHead>
              <TableHead className="px-4 text-right">Median cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.repositories.map((repository) => (
              <TableRow key={repository.id}>
                <TableCell className="min-w-0 px-4 py-3">
                  <div className="truncate font-display text-sm text-dashboard-text">
                    <Link
                      className="text-inherit no-underline hover:text-dashboard-accent-text"
                      to={codeRepositoryPath(repository.id)}
                    >
                      {repository.name}
                    </Link>
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
                    {repository.provider}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-sans tabular-nums">
                  {repository.created}
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-sans tabular-nums">
                  {formatMergeRate(repository.mergeRate)}
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-sans tabular-nums">
                  {formatCodeCost(repository.medianCostUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/** The newest code changes, when there are any. */
export function CodeRecentChanges(props: {
  changes: CodeOverviewReport["changes"];
}) {
  if (props.changes.length === 0) return null;
  return (
    <Card as="section">
      <div className="border-b border-dashboard-border-subtle px-4 py-3 font-display text-lg text-dashboard-text">
        Recent changes
      </div>
      <div>
        <CodeChangeRows changes={props.changes} />
      </div>
    </Card>
  );
}
