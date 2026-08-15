import { useQuery } from "@tanstack/react-query";
import {
  statsReportSchema,
  type WorkspaceReport,
} from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { fetchDashboardJson } from "../../http";
import { SnapshotSummary } from "./SnapshotSummary";
import { WorkspaceSwitchChart } from "./WorkspaceSwitchChart";
import { workspaceSwitchDays } from "./workspaceSwitchStats";

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
  const days = workspaceSwitchDays({
    name: props.workspace.name,
    range: props.range,
    stats: statsQuery.data?.stats ?? [],
  });

  return (
    <div className="grid min-w-0 gap-4">
      <SnapshotSummary
        description="New Sandboxes start from this prepared snapshot."
        emptyDescription="No snapshot yet. The first successful prepare creates one."
        headingId="workspace-snapshot-heading"
        snapshot={props.workspace.snapshot}
        title="Current snapshot"
      />
      {statsQuery.error ? (
        <Card padding="sm">
          <EmptyTelemetry>
            Workspace switch stats failed to load.
          </EmptyTelemetry>
        </Card>
      ) : (
        <WorkspaceSwitchChart
          days={days}
          range={props.range}
          workspaceName={props.workspace.name}
        />
      )}
    </div>
  );
}
