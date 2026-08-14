import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  workspaceListSchema,
  workspaceSchema,
  type WorkspaceReport,
} from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../../agentName";
import { Button } from "../../components/Button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import {
  DashboardApiError,
  deleteDashboardResource,
  fetchDashboardJson,
  post,
  put,
} from "../../http";
import { SystemPageLayout } from "./SystemPageLayout";
import { WorkspaceEditor } from "./WorkspaceEditor";
import { WorkspaceList } from "./WorkspaceList";
import {
  canSaveWorkspaceDraft,
  createWorkspaceDraft,
  editWorkspaceDraft,
  type WorkspaceDraft,
  workspaceDraftBody,
} from "./workspaceDraft";

const workspacesQueryKey = ["dashboard", "workspaces"] as const;

function readApiError(error: unknown, fallback: string): string {
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
  const [editingId, setEditingId] = useState<string | undefined>();
  const [draft, setDraft] = useState<WorkspaceDraft>();
  const [formError, setFormError] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const workspacesQuery = useQuery({
    queryKey: workspacesQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(workspaceListSchema, "/api/workspaces", signal),
    retry: false,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Workspace draft is required");
      const body = workspaceDraftBody(draft);
      return editingId
        ? put(
            workspaceSchema,
            `/api/workspaces/${encodeURIComponent(editingId)}`,
            body,
          )
        : post(workspaceSchema, "/api/workspaces", body);
    },
    onSuccess: async (workspace) => {
      closeEditor();
      setActionError(undefined);
      await queryClient.cancelQueries({ queryKey: workspacesQueryKey });
      queryClient.setQueryData<{ workspaces: WorkspaceReport[] }>(
        workspacesQueryKey,
        (current) => ({
          workspaces: [
            workspace,
            ...(current?.workspaces ?? []).filter(
              (item) => item.id !== workspace.id,
            ),
          ].sort((left, right) => left.name.localeCompare(right.name)),
        }),
      );
    },
    onError: (error) => {
      setFormError(
        readApiError(error, "Could not save the Workspace. Try again."),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (workspace: WorkspaceReport) => {
      await deleteDashboardResource(
        `/api/workspaces/${encodeURIComponent(workspace.id)}`,
      );
      return workspace;
    },
    onSuccess: async (workspace) => {
      setActionError(undefined);
      if (editingId === workspace.id) closeEditor();
      await queryClient.cancelQueries({ queryKey: workspacesQueryKey });
      queryClient.setQueryData<{ workspaces: WorkspaceReport[] }>(
        workspacesQueryKey,
        (current) => ({
          workspaces: (current?.workspaces ?? []).filter(
            (item) => item.id !== workspace.id,
          ),
        }),
      );
    },
    onError: (error) => {
      setActionError(
        readApiError(error, "Could not delete the Workspace. Try again."),
      );
    },
  });

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const busy = saveMutation.isPending || deleteMutation.isPending;

  function closeEditor() {
    setDraft(undefined);
    setEditingId(undefined);
    setFormError(undefined);
  }

  function openCreate() {
    setEditingId(undefined);
    setDraft(createWorkspaceDraft());
    setFormError(undefined);
  }

  function openEdit(workspace: WorkspaceReport) {
    setEditingId(workspace.id);
    setDraft(editWorkspaceDraft(workspace));
    setFormError(undefined);
  }

  function confirmDelete(workspace: WorkspaceReport) {
    if (
      window.confirm(
        `Delete Workspace “${workspace.name}”? Active conversations keep their current Sandbox until the next switch.`,
      )
    ) {
      deleteMutation.mutate(workspace);
    }
  }

  if (!workspacesQuery.data && !workspacesQuery.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading Workspaces" />
      </SystemPageLayout>
    );
  }

  return (
    <SystemPageLayout>
      <PageHeader
        actions={
          <Button disabled={busy} onClick={openCreate}>
            <Plus aria-hidden="true" size={14} />
            New Workspace
          </Button>
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

      {actionError ? (
        <p className="m-0 text-sm text-rose-300" role="alert">
          {actionError}
        </p>
      ) : null}

      {draft ? (
        <WorkspaceEditor
          busy={busy}
          canSave={canSaveWorkspaceDraft(draft, busy)}
          draft={draft}
          editing={editingId !== undefined}
          error={formError}
          onCancel={closeEditor}
          onChange={setDraft}
          onSubmit={() => saveMutation.mutate()}
        />
      ) : null}

      <WorkspaceList
        busy={busy}
        onDelete={confirmDelete}
        onEdit={openEdit}
        workspaces={workspaces}
      />
    </SystemPageLayout>
  );
}
