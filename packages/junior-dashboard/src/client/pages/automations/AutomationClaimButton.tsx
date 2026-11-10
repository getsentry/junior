import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationSummary,
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
import { Button } from "../../components/ui/button";
import { FormNotice } from "../../components/FormNotice";
import { useToastManager } from "../../components/ui/toast";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";

/** Make the viewer the creator. A claim switches to Junior's credentials. */
export function AutomationClaimButton(props: {
  automation: AutomationSummary;
}) {
  const { automation } = props;
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToastManager();
  const claim = useMutation({
    mutationFn: async () => {
      const path = `/api/automations/${encodeURIComponent(automation.id)}`;
      const current = await fetchDashboardJson(
        automationEditSchema,
        `${path}/edit`,
      );
      return post(automationEditSchema, `${path}/claim`, {
        revision: current.revision,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "automations"],
      });
      toast.add({
        title: "Automation claimed",
        description: "Future runs use Junior's credentials only.",
        type: "success",
      });
      setOpen(false);
    },
  });
  return (
    <>
      <Button className="justify-self-start" onClick={() => setOpen(true)}>
        Claim automation
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next, details) => {
          if (claim.isPending) details.cancel();
          else setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Claim this automation?</AlertDialogTitle>
          <AlertDialogDescription>
            You become its creator, and {automation.createdBy} no longer is.
            Runs use Junior's credentials only. Its status does not change.
          </AlertDialogDescription>
          {claim.error ? (
            <FormNotice tone="error" title="Could not claim this automation.">
              {claim.error instanceof DashboardApiError
                ? (claim.error.apiError ?? "Try again.")
                : claim.error.message}
            </FormNotice>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={claim.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={claim.isPending}
              onClick={() => claim.mutate()}
            >
              {claim.isPending ? "Claiming…" : "Claim automation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
