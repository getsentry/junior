import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  workspaceListSchema,
  type BaselineSnapshotReport,
  type WorkspaceReport,
} from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../../agentName";
import { ButtonLink } from "../../components/Button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { InlineError } from "../../components/InlineError";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import {
  DashboardApiError,
  deleteDashboardResource,
  fetchDashboardJson,
} from "../../http";
import { BaselineSnapshotCard } from "./BaselineSnapshotCard";
import { SystemPageLayout } from "./SystemPageLayout";
import { WorkspaceList } from "./WorkspaceList";

export const workspacesQueryKey = ["dashboard", "workspaces"] as const;

/** Return a useful dashboard error message without exposing response details. */
export function readWorkspaceApiError(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof DashboardApiError) {
    return error.apiError ?? fallback;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/** Manage install-wide repository Workspace recipes. */
export function WorkspacesPage() {
  const queryClient = useQueryClient();
  const workspacesQuery = useQuery({
    queryKey: workspacesQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(workspaceListSchema, "/api/workspaces", signal),
    retry: false,
  });
  const deleteMutation = useMutation({
    mutationFn: async (workspace: WorkspaceReport) => {
      await deleteDashboardResource(
        `/api/workspaces/${encodeURIComponent(workspace.id)}`,
      );
      return workspace;
    },
    onSuccess: async (workspace) => {
      await queryClient.cancelQueries({ queryKey: workspacesQueryKey });
      queryClient.setQueryData<{
        baselineSnapshot: BaselineSnapshotReport | null;
        workspaces: WorkspaceReport[];
      }>(workspacesQueryKey, (current) => ({
        baselineSnapshot: current?.baselineSnapshot ?? null,
        workspaces: (current?.workspaces ?? []).filter(
          (item) => item.id !== workspace.id,
        ),
      }));
    },
  });

  if (!workspacesQuery.data && !workspacesQuery.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading Workspaces" />
      </SystemPageLayout>
    );
  }

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const baselineSnapshot = workspacesQuery.data?.baselineSnapshot ?? null;
  return (
    <SystemPageLayout>
      <PageHeader
        actions={
          <ButtonLink to="/system/workspaces/new">
            <Plus aria-hidden="true" size={14} />
            New Workspace
          </ButtonLink>
        }
        description={`Named repository recipes ${getDashboardAgentName()} can switch into without cloning each turn.`}
        title="Workspaces"
      />

      {workspacesQuery.error ? (
        <Card padding="sm">
          <EmptyTelemetry>
            Workspaces failed to load. Try refreshing the dashboard.
          </EmptyTelemetry>
        </Card>
      ) : null}

      {deleteMutation.error ? (
        <InlineError>
          {readWorkspaceApiError(
            deleteMutation.error,
            "Could not delete the Workspace. Try again.",
          )}
        </InlineError>
      ) : null}

      {!workspacesQuery.error ? (
        <BaselineSnapshotCard snapshot={baselineSnapshot} />
      ) : null}

      <WorkspaceList
        busy={deleteMutation.isPending}
        onDelete={(workspace) => {
          if (
            window.confirm(
              `Delete Workspace “${workspace.name}”? Active conversations keep their current Sandbox until the next switch.`,
            )
          ) {
            deleteMutation.mutate(workspace);
          }
        }}
        workspaces={workspaces}
      />
    </SystemPageLayout>
  );
}
