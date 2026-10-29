import { Pencil, Trash2 } from "lucide-react";
import { Link } from "react-router";
import type { StatsReport, WorkspaceReport } from "@sentry/junior/api/schema";

import { useStatsData } from "../../api";
import { buttonVariants, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { Detail, DetailList } from "../../components/DetailList";
import { DetailsPanel } from "../../components/DetailsPanel";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { WorkspaceUsageChart } from "../../components/charts/WorkspaceUsageChart";
import { workspaceUsageDays } from "../../components/charts/workspaceUsage";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import {
  formatMs,
  formatRelativeTime,
  formatTime,
  workspacePath,
} from "../../format";
import { formatSandboxSize } from "./sandboxSize";
import { useWorkspaceData } from "./workspaceQueries";

// Workspace switch counters are daily-only (`junior_stats.date`).
const USAGE_RANGE: TimeRangeDays = 30;

/**
 * Show one Workspace beside the list with Edit and Delete in the header. The
 * list item renders at once; the detail read adds the current snapshot.
 */
export function WorkspaceDetails(props: {
  defaultVcpus: number | null;
  listError: boolean;
  onClose(): void;
  onDelete(workspace: WorkspaceReport, source: HTMLButtonElement): void;
  workspace: WorkspaceReport | undefined;
  workspaceId: string;
}) {
  const detail = useWorkspaceData(props.workspaceId);
  const statsQuery = useStatsData();
  const workspace = detail.data ?? props.workspace;
  const missing = !workspace && (detail.isError || props.listError);
  return (
    <DetailsPanel
      actions={
        workspace ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Link
                    aria-label={`Edit ${workspace.name}`}
                    className={buttonVariants({ size: "icon" })}
                    to={`${workspacePath(workspace.id)}/edit`}
                  >
                    <Pencil aria-hidden="true" size={15} />
                  </Link>
                }
              />
              <TooltipContent size="compact">Edit Workspace</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Delete ${workspace.name}`}
                    onClick={(event) =>
                      props.onDelete(workspace, event.currentTarget)
                    }
                    size="icon"
                  >
                    <Trash2 aria-hidden="true" size={15} />
                  </Button>
                }
              />
              <TooltipContent size="compact">Delete Workspace</TooltipContent>
            </Tooltip>
          </>
        ) : undefined
      }
      label="Workspace details"
      onClose={props.onClose}
      sheetTitle={workspace?.name}
      title={
        <h2 className="m-0 break-words font-display text-base font-medium text-dashboard-text">
          {workspace?.name ?? "Workspace details"}
        </h2>
      }
    >
      <div className="p-4 [overflow-wrap:anywhere]">
        {workspace ? (
          <WorkspaceDetailsContent
            defaultVcpus={props.defaultVcpus}
            error={Boolean(statsQuery.error)}
            loading={statsQuery.isPending}
            snapshot={
              detail.data ? "ready" : detail.isError ? "error" : "loading"
            }
            stats={statsQuery.data}
            workspace={workspace}
          />
        ) : missing ? (
          <EmptyTelemetry>
            Workspace not found. It may have been deleted.
          </EmptyTelemetry>
        ) : (
          <PageContentSkeleton
            label="Loading Workspace details"
            variant="panel"
          />
        )}
      </div>
    </DetailsPanel>
  );
}

/** Present repositories, Sandbox size, snapshot, setup, and switch volume for one Workspace. */
export function WorkspaceDetailsContent(props: {
  defaultVcpus: number | null;
  error: boolean;
  loading: boolean;
  snapshot: "error" | "loading" | "ready";
  stats: StatsReport | undefined;
  workspace: WorkspaceReport;
}) {
  const { workspace } = props;
  return (
    <div className="grid min-w-0 gap-4">
      <DetailList>
        <Detail label="Repositories">
          {workspace.repos.length === 0 ? (
            <span className="text-dashboard-text-muted">None</span>
          ) : (
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {workspace.repos.map((repo) => (
                <li className="min-w-0" key={`${repo.provider}:${repo.repo}`}>
                  <span className="block font-mono text-xs text-dashboard-text">
                    {repo.provider}:{repo.repo}
                  </span>
                  <span className="block font-mono text-xs text-dashboard-text-muted">
                    {repo.checkoutPath}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Detail>
        <Detail label="Sandbox size">
          {formatSandboxSize(workspace.vcpus ?? props.defaultVcpus)}
          {workspace.vcpus === null ? (
            <span className="text-dashboard-text-muted"> · default</span>
          ) : null}
        </Detail>
        <Detail label="Snapshot">
          <WorkspaceSnapshot state={props.snapshot} workspace={workspace} />
        </Detail>
        <Detail label="Setup script">
          {workspace.setupScript.trim() ? (
            <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-dashboard-fill-soft p-2 font-mono text-xs leading-relaxed text-dashboard-text">
              {workspace.setupScript}
            </pre>
          ) : (
            <span className="text-dashboard-text-muted">None</span>
          )}
        </Detail>
      </DetailList>
      {!props.stats ? (
        <EmptyTelemetry>
          {props.error
            ? "Workspace usage failed to load."
            : props.loading
              ? "Loading Workspace usage."
              : "No usage in this period."}
        </EmptyTelemetry>
      ) : (
        <div className="grid min-w-0 gap-3">
          {props.error ? (
            <p className="m-0 font-sans text-xs text-rose-200/65">
              Workspace usage refresh failed. Showing cached data.
            </p>
          ) : null}
          <WorkspaceUsageChart
            days={workspaceUsageDays({
              workspaceId: workspace.id,
              range: USAGE_RANGE,
              stats: props.stats.stats,
            })}
            range={USAGE_RANGE}
            workspaceName={workspace.name}
          />
        </div>
      )}
    </div>
  );
}

function WorkspaceSnapshot(props: {
  state: "error" | "loading" | "ready";
  workspace: WorkspaceReport;
}) {
  if (props.state === "loading") {
    return (
      <span className="grid gap-1.5" role="status">
        <span className="sr-only">Loading snapshot</span>
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3.5 w-48" />
      </span>
    );
  }
  if (props.state === "error") {
    return (
      <span className="text-dashboard-text-muted">
        Snapshot status could not be loaded.
      </span>
    );
  }
  const snapshot = props.workspace.snapshot;
  if (!snapshot) {
    return (
      <span className="text-dashboard-text-muted">
        Not built yet. The first successful prepare builds it.
      </span>
    );
  }
  return (
    <>
      <span className="block tabular-nums">
        <span title={formatTime(snapshot.generatedAt)}>
          {formatRelativeTime(snapshot.generatedAt)}
        </span>{" "}
        · built in {formatMs(snapshot.buildDurationMs)}
      </span>
      <span className="block break-all font-mono text-xs text-dashboard-text-muted">
        {snapshot.id}
      </span>
    </>
  );
}
