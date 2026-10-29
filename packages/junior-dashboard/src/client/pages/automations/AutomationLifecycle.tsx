import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import { CircleHelp } from "lucide-react";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Button, ButtonLink } from "../../components/Button";
import { FormNotice } from "../../components/FormNotice";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";

/** Keep revision-checked lifecycle actions available in the fixed details footer. */
export function AutomationLifecycle({
  automation,
  editPath,
}: {
  automation: AutomationSummary;
  editPath: string;
}) {
  const queryClient = useQueryClient();
  const completed = automation.status === "completed";
  const paused = automation.status === "paused";
  const blocked = automation.status === "blocked";
  // Public readers can edit settings, but only the creator controls lifecycle.
  const canEdit = !completed;
  const canPause = automation.ownedByViewer && !completed;
  const action = paused || blocked ? "resume" : "pause";
  const mutation = useMutation({
    mutationFn: async () => {
      const path = `/api/automations/${encodeURIComponent(automation.id)}`;
      const current = await fetchDashboardJson(
        automationEditSchema,
        `${path}/edit`,
      );
      // Do not apply the opposite action if another surface changed lifecycle.
      if (current.status !== automation.status) {
        throw new Error(
          "The Automation changed. Close and reopen its details before trying again.",
        );
      }
      return post(automationEditSchema, `${path}/lifecycle`, {
        action,
        revision: current.revision,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "automations"],
      });
    },
  });
  return (
    <footer
      aria-label="Automation actions"
      className="grid gap-3 border-t border-dashboard-border bg-dashboard-bg-elevated p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex items-center gap-2">
        <ButtonLink
          aria-label={canEdit ? "Edit automation" : "View settings"}
          className="mr-auto min-h-11"
          to={editPath}
        >
          {canEdit ? "Edit" : "View settings"}
        </ButtonLink>
        {canPause ? (
          <>
            <Button
              className="min-h-11"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending
                ? "Updating…"
                : action === "pause"
                  ? "Pause"
                  : "Resume"}
            </Button>
            <Popover.Root>
              <Popover.Trigger
                render={
                  <Button
                    aria-label="About pausing"
                    className="min-h-11 min-w-11"
                    size="icon"
                  />
                }
              >
                <CircleHelp aria-hidden="true" size={16} />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner
                  side="top"
                  align="end"
                  sideOffset={8}
                  className="z-50"
                >
                  <Popover.Popup
                    aria-label="About pausing"
                    className="max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-4 text-sm text-dashboard-text shadow-lg outline-none focus-visible:outline-2 focus-visible:outline-dashboard-focus"
                  >
                    <Popover.Description className="m-0 leading-relaxed text-dashboard-text-muted">
                      Pausing stops new runs. Work already queued or running may
                      finish. Resuming skips missed runs and waits for the next
                      scheduled time or new event.
                      {paused && automation.statusReason
                        ? " Removing the pause keeps the block until you fix it and resume again."
                        : ""}
                    </Popover.Description>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          </>
        ) : null}
      </div>
      {mutation.error ? (
        <FormNotice tone="error" title="Could not update this automation.">
          {mutation.error instanceof DashboardApiError
            ? (mutation.error.apiError ?? "Try again.")
            : mutation.error.message}
        </FormNotice>
      ) : null}
    </footer>
  );
}
