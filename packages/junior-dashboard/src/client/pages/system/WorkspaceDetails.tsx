import { useQuery } from "@tanstack/react-query";
import {
  statsReportSchema,
  type WorkspaceReport,
} from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { WorkspaceUsageChart } from "../../components/charts/WorkspaceUsageChart";
import { workspaceUsageDays } from "../../components/charts/workspaceUsage";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { fetchDashboardJson } from "../../http";
import { SnapshotSummary } from "./SnapshotSummary";

/** Show snapshot metadata and switch volume for one Workspace recipe. */
export function WorkspaceDetails(props: {
  range: TimeRangeDays;
  workspace: WorkspaceReport;
}) {
  const statsQuery = useQuery({
    queryKey: ["dashboard", "stats", "workspace-switch"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(statsReportSchema, "/api/stats", signal),
    retry: false,
  });
  const days = statsQuery.data
    ? workspaceUsageDays({
        workspaceId: props.workspace.id,
        range: props.range,
        stats: statsQuery.data.stats,
      })
    : [];

  return (
    <div className="grid min-w-0 gap-4">
      <SnapshotSummary
        description="New Sandboxes start from this prepared snapshot."
        emptyDescription="No snapshot yet. The first successful prepare creates one."
        headingId="workspace-snapshot-heading"
        snapshot={props.workspace.snapshot}
        title="Current snapshot"
      />
      {!statsQuery.data ? (
        <Card padding="sm">
          <EmptyTelemetry>
            {statsQuery.error
              ? "Workspace usage failed to load."
              : "Loading Workspace usage."}
          </EmptyTelemetry>
        </Card>
      ) : (
        <div className="grid min-w-0 gap-3">
          {statsQuery.error ? (
            <p className="m-0 font-mono text-xs text-rose-200/65">
              Workspace usage refresh failed. Showing cached data.
            </p>
          ) : null}
          <WorkspaceUsageChart
            days={days}
            range={props.range}
            workspaceName={props.workspace.name}
          />
        </div>
      )}
    </div>
  );
}
