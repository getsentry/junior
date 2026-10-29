import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  workspaceSchema,
  type WorkspaceListReport,
} from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { workspacePath } from "../../format";
import { post, put } from "../../http";
import { SystemPageLayout } from "./SystemPageLayout";
import { WorkspaceEditor } from "./WorkspaceEditor";
import {
  readWorkspaceApiError,
  useWorkspaceData,
  useWorkspacesData,
  workspaceQueryKey,
  workspacesQueryKey,
} from "./workspaceQueries";
import {
  canSaveWorkspaceDraft,
  createWorkspaceDraft,
  editWorkspaceDraft,
  type WorkspaceDraft,
  workspaceDraftBody,
} from "./workspaceDraft";

/** Create or edit one Workspace recipe on a full page. */
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

  const workspaceQuery = useWorkspaceData(workspaceId);
  // Shares the list cache so the default size is usually loaded already.
  const workspacesQuery = useWorkspacesData();
  const defaultVcpus = workspacesQuery.data?.defaultVcpus ?? null;

  // Seed the edit draft once per Workspace id. editWorkspaceDraft assigns fresh
  // repo keys, so calling it during every query-driven render remounts fields.
  useEffect(() => {
    if (!editing || !workspaceId || !workspaceQuery.data) return;
    if (editedDraft?.workspaceId === workspaceId) return;
    setEditedDraft({
      draft: editWorkspaceDraft(workspaceQuery.data),
      workspaceId,
    });
  }, [editing, editedDraft?.workspaceId, workspaceId, workspaceQuery.data]);

  const draft = editing
    ? editedDraft?.workspaceId === workspaceId
      ? editedDraft.draft
      : undefined
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
      queryClient.setQueryData<WorkspaceListReport>(
        workspacesQueryKey,
        (current) =>
          current && {
            ...current,
            workspaces: [
              workspace,
              ...current.workspaces.filter((item) => item.id !== workspace.id),
            ].sort((left, right) => left.name.localeCompare(right.name)),
          },
      );
      // A recipe change can retire the current snapshot; read it again.
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKey(workspace.id),
      });
      navigate(workspacePath(workspace.id));
    },
  });

  if (editing && !workspaceQuery.error && (!workspaceQuery.data || !draft)) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading Workspace" />
      </SystemPageLayout>
    );
  }

  return (
    <SystemPageLayout>
      <div className="grid min-w-0 gap-4 sm:gap-5">
        <PageHeader
          description={
            editing
              ? "Change the repositories, setup script, or Sandbox size."
              : "Name the recipe, choose repositories, and optionally add a one-time setup script."
          }
          title={
            editing
              ? (workspaceQuery.data?.name ?? "Workspace")
              : "New Workspace"
          }
        />

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
            cancelPath={
              workspaceId ? workspacePath(workspaceId) : "/system/workspaces"
            }
            defaultVcpus={defaultVcpus}
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
      </div>
    </SystemPageLayout>
  );
}
