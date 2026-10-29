import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  WorkspaceListReport,
  WorkspaceReport,
} from "@sentry/junior/api/schema";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { useToastManager } from "../../components/ui/toast";
import { FormNotice } from "../../components/FormNotice";
import { deleteDashboardResource } from "../../http";
import { readWorkspaceApiError, workspacesQueryKey } from "./workspaceQueries";

/** Confirm Workspace deletion by name and keep a failed request open for retry. */
export function WorkspaceDeleteDialog(props: {
  onClose(): void;
  onDeleted(): void;
  returnFocus(): HTMLElement | false;
  workspace: WorkspaceReport;
}) {
  const [open, setOpen] = useState(true);
  const queryClient = useQueryClient();
  const toast = useToastManager();
  const deletion = useMutation({
    mutationFn: () =>
      deleteDashboardResource(
        `/api/workspaces/${encodeURIComponent(props.workspace.id)}`,
      ),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: workspacesQueryKey });
      queryClient.setQueryData<WorkspaceListReport>(
        workspacesQueryKey,
        (current) =>
          current && {
            ...current,
            workspaces: current.workspaces.filter(
              (item) => item.id !== props.workspace.id,
            ),
          },
      );
      props.onDeleted();
      toast.add({
        title: "Workspace deleted",
        description: props.workspace.name,
        type: "success",
      });
      setOpen(false);
    },
  });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, details) => {
        if (deletion.isPending) details.cancel();
        else setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClose();
      }}
    >
      <AlertDialogContent finalFocus={props.returnFocus}>
        <AlertDialogTitle>Delete Workspace?</AlertDialogTitle>
        <AlertDialogDescription>
          Delete{" "}
          <strong className="font-medium text-dashboard-text">
            {props.workspace.name}
          </strong>
          ? Active conversations keep their current Sandbox until the next
          switch.
        </AlertDialogDescription>
        {deletion.error ? (
          <FormNotice
            tone="error"
            title={readWorkspaceApiError(
              deletion.error,
              "Could not delete the Workspace. Try again.",
            )}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletion.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={deletion.isPending}
            onClick={() => deletion.mutate()}
            variant="danger"
          >
            {deletion.isPending ? "Deleting…" : "Delete Workspace"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
