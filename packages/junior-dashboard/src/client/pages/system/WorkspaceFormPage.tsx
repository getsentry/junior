import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  workspaceSchema,
  type WorkspaceReport,
} from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { fetchDashboardJson, post, put } from "../../http";
import { SystemPageLayout } from "./SystemPageLayout";
import { WorkspaceDetails } from "./WorkspaceDetails";
import { WorkspaceEditor } from "./WorkspaceEditor";
import {
  readWorkspaceApiError,
  workspacesQueryKey,
} from "./WorkspacesPage";
import {
  canSaveWorkspaceDraft,
  createWorkspaceDraft,
  editWorkspaceDraft,
  type WorkspaceDraft,
  workspaceDraftBody,
} from "./workspaceDraft";

/** Create or edit one Workspace at a stable dashboard route. */
export function WorkspaceFormPage() {
  const { workspaceId } = useParams();
  const editing = workspaceId !== undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newDraft, setNewDraft] = useState(createWorkspaceDraft);
  const [editedDraft, setEditedDraft] = useState<{
    draft: WorkspaceDraft;
    workspaceId: string;
  }>();

  const workspaceQuery = useQuery({
    enabled: editing,
    queryKey: ["dashboard", "workspace", workspaceId],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        workspaceSchema,
        `/api/workspaces/${encodeURIComponent(workspaceId!)}`,
        signal,
      ),
    retry: false,
  });
  const draft = editing
    ? (editedDraft?.workspaceId === workspaceId
        ? editedDraft.draft
        : undefined) ??
      (workspaceQuery.data
        ? editWorkspaceDraft(workspaceQuery.data)
        : undefined)
    : newDraft;

  const saveMutation = useMutation({
    mutationFn: async (value: WorkspaceDraft) => {
      const body = workspaceDraftBody(value);
      return editing
        ? put(
            workspaceSchema,
            `/api/workspaces/${encodeURIComponent(workspaceId!)}`,
            body,
          )
        : post(workspaceSchema, "/api/workspaces", body);
    },
    onSuccess: async (workspace) => {
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
      navigate("/system/workspaces");
    },
  });

  if (editing && !workspaceQuery.data && !workspaceQuery.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading Workspace" />
      </SystemPageLayout>
    );
  }

  return (
    <SystemPageLayout>
      <Link
        className="flex w-fit items-center gap-2 font-display text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text"
        to="/system/workspaces"
      >
        <ArrowLeft aria-hidden="true" size={15} strokeWidth={1.8} />
        Back to Workspaces
      </Link>

      <PageHeader
        description={
          editing
            ? "Update the repositories and setup used to prepare this Workspace."
            : "Define the repositories and setup used to prepare a new Workspace."
        }
        title={editing ? (workspaceQuery.data?.name ?? "Workspace") : "New Workspace"}
      />

      {editing && workspaceQuery.data ? (
        <WorkspaceDetails workspace={workspaceQuery.data} />
      ) : null}

      {workspaceQuery.error ? (
        <Card padding="sm">
          <EmptyTelemetry>
            {readWorkspaceApiError(
              workspaceQuery.error,
              "Workspace not found. It may have been deleted.",
            )}
          </EmptyTelemetry>
        </Card>
      ) : draft ? (
        <WorkspaceEditor
          busy={saveMutation.isPending}
          canSave={canSaveWorkspaceDraft(draft, saveMutation.isPending)}
          draft={draft}
          editing={editing}
          error={
            saveMutation.error
              ? readWorkspaceApiError(
                  saveMutation.error,
                  "Could not save the Workspace. Try again.",
                )
              : undefined
          }
          onChange={
            editing
              ? (value) => setEditedDraft({ draft: value, workspaceId })
              : setNewDraft
          }
          onSubmit={() => saveMutation.mutate(draft)}
        />
      ) : null}
    </SystemPageLayout>
  );
}
