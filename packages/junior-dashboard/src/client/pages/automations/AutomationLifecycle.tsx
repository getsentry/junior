import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverDescription,
} from "../../components/ui/popover";
import { useToastManager } from "../../components/ui/toast";
import { IconButtonTooltip } from "../../components/Tooltip";
import { Link } from "react-router";
import { CircleHelp, Pencil, Settings2, Trash2 } from "lucide-react";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Button } from "../../components/Button";
import { FormNotice } from "../../components/FormNotice";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";

/** Keep revision-checked lifecycle actions available in the fixed details footer. */
export function AutomationLifecycle({
  automation,
  editPath,
  onDelete,
}: {
  automation: AutomationSummary;
  editPath: string;
  onDelete(source: HTMLButtonElement): void;
}) {
  const toast = useToastManager();
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
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "automations"],
      });
      toast.add({
        title:
          updated.status === "blocked"
            ? "Automation is still blocked"
            : action === "pause"
              ? "Automation paused"
              : "Automation resumed",
        description:
          updated.status === "blocked"
            ? "Fix the reported requirement before resuming again."
            : action === "pause"
              ? "Work already queued or running may finish."
              : "Future triggers are enabled.",
        type: updated.status === "blocked" ? "warning" : "success",
      });
    },
  });
  return (
    <footer
      aria-label="Automation actions"
      className="grid gap-3 border-t border-dashboard-border bg-dashboard-bg-elevated p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex items-center gap-2">
        <div className="mr-auto flex items-center gap-1">
          <IconButtonTooltip
            label={canEdit ? "Edit automation" : "View settings"}
          >
            <Link
              aria-label={canEdit ? "Edit automation" : "View settings"}
              className="grid size-11 place-items-center rounded-md text-dashboard-text-muted no-underline hover:bg-dashboard-fill-strong hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
              to={editPath}
            >
              {canEdit ? (
                <Pencil aria-hidden="true" size={16} />
              ) : (
                <Settings2 aria-hidden="true" size={16} />
              )}
            </Link>
          </IconButtonTooltip>
          {automation.ownedByViewer ? (
            <IconButtonTooltip label="Delete automation">
              <Button
                aria-label="Delete automation"
                className="min-h-11 min-w-11"
                size="icon"
                tone="danger"
                onClick={(event) => onDelete(event.currentTarget)}
                disabled={mutation.isPending}
              >
                <Trash2 aria-hidden="true" size={16} />
              </Button>
            </IconButtonTooltip>
          ) : null}
        </div>
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
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    aria-label="About pausing"
                    className="min-h-11 min-w-11"
                    size="icon"
                  />
                }
              >
                <CircleHelp aria-hidden="true" size={16} />
              </PopoverTrigger>
              <PopoverContent side="top" align="end" aria-label="About pausing">
                <PopoverDescription>
                  Pausing stops new runs. Work already queued or running may
                  finish. Resuming skips missed runs and waits for the next
                  scheduled time or new event.
                  {paused && automation.statusReason
                    ? " Removing the pause keeps the block until you fix it and resume again."
                    : ""}
                </PopoverDescription>
              </PopoverContent>
            </Popover>
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
