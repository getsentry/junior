import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AutomationListItem } from "@sentry/junior/api/schema";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../../components/ui/alert-dialog";
import { FormNotice } from "../../components/FormNotice";
import { deleteDashboardResource } from "../../http";
import { refreshDeletedAutomation } from "../../review-desk/inboxQueries";

/** Confirm deletion by name and keep a failed request available for retry. */
export function AutomationDeleteDialog(props: {
  automation: AutomationListItem;
  onClose(): void;
  onDeleted(): void;
  returnFocus(): HTMLElement | false;
}) {
  const [open, setOpen] = useState(true);
  const queryClient = useQueryClient();
  const deletion = useMutation({
    mutationFn: () =>
      deleteDashboardResource(
        `/api/automations/${encodeURIComponent(props.automation.id)}`,
      ),
    onSuccess: async () => {
      await refreshDeletedAutomation(queryClient, props.automation.id);
      props.onDeleted();
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
        <AlertDialogTitle>Delete automation?</AlertDialogTitle>
        <AlertDialogDescription>
          Delete{" "}
          <strong className="font-medium text-dashboard-text">
            {props.automation.title}
          </strong>
          ? This removes the Automation and stops future triggers. Work already
          queued or running may finish.
        </AlertDialogDescription>
        {deletion.error ? (
          <FormNotice
            tone="error"
            title="The automation could not be deleted. Try again."
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletion.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deletion.isPending}
            onClick={() => deletion.mutate()}
          >
            {deletion.isPending ? "Deleting…" : "Delete automation"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
