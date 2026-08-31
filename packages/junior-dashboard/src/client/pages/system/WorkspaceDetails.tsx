import type {
  StatsReport,
  WorkspaceReport,
} from "@sentry/junior/api/schema";

import { useStatsData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { WorkspaceUsageChart } from "../../components/charts/WorkspaceUsageChart";
import { workspaceUsageDays } from "../../components/charts/workspaceUsage";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SnapshotSummary } from "./SnapshotSummary";

/** Load Workspace usage stats and render snapshot plus switch volume. */
export function WorkspaceDetails(props: {
  range: TimeRangeDays;
  workspace: WorkspaceReport;
}) {
  const statsQuery = useStatsData();
  return (
    <WorkspaceDetailsContent
      error={Boolean(statsQuery.error)}
      loading={statsQuery.isPending}
      range={props.range}
      stats={statsQuery.data}
      workspace={props.workspace}
    />
  );
}

/** Present snapshot metadata and switch volume for one Workspace recipe. */
export function WorkspaceDetailsContent(props: {
  error: boolean;
  loading: boolean;
  range: TimeRangeDays;
  stats: StatsReport | undefined;
  workspace: WorkspaceReport;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <SnapshotSummary
        description="New Sandboxes start from this prepared snapshot."
        emptyDescription="No snapshot yet. The first successful prepare creates one."
        headingId="workspace-snapshot-heading"
        snapshot={props.workspace.snapshot}
        title="Current snapshot"
      />
      {!props.stats ? (
        <Card padding="sm">
          <EmptyTelemetry>
            {props.error
              ? "Workspace usage failed to load."
              : props.loading
                ? "Loading Workspace usage."
                : "No usage in this period."}
          </EmptyTelemetry>
        </Card>
      ) : (
        <div className="grid min-w-0 gap-3">
          {props.error ? (
            <p className="m-0 font-mono text-xs text-rose-200/65">
              Workspace usage refresh failed. Showing cached data.
            </p>
          ) : null}
          <WorkspaceUsageChart
            days={workspaceUsageDays({
              workspaceId: props.workspace.id,
              // Daily counters only; keep 24h off this chart via page range options.
              range: props.range === 1 ? 7 : props.range,
              stats: props.stats.stats,
            })}
            range={props.range === 1 ? 7 : props.range}
            workspaceName={props.workspace.name}
          />
        </div>
      )}
    </div>
  );
}
