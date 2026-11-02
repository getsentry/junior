import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverDescription,
} from "../../components/ui/popover";
import { useToastManager } from "../../components/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { Link } from "react-router";
import { CircleHelp, Pencil, Trash2 } from "lucide-react";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Button, buttonVariants } from "../../components/ui/button";
import { FormNotice } from "../../components/FormNotice";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";

/**
 * Header actions for one Automation: Edit, then creator-only Pause or Resume
 * and Delete. Public readers can edit settings, but only the creator controls
 * lifecycle. Lifecycle actions re-read the revision before they apply.
 */
export function AutomationActions({
  automation,
  editPath,
  editVariant,
  onDelete,
}: {
  automation: AutomationSummary;
  editPath: string;
  /** Use "default" when a notice on the page owns the main action. */
  editVariant: "default" | "primary";
  onDelete(source: HTMLButtonElement): void;
}) {
  const toast = useToastManager();
  const queryClient = useQueryClient();
  const completed = automation.status === "completed";
  const paused = automation.status === "paused";
  const blocked = automation.status === "blocked";
  const canPause = !completed;
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
          "The Automation changed. Reload the page before trying again.",
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
    <div className="grid min-w-0 justify-items-stretch gap-3 md:justify-items-end">
      <div
        aria-label="Automation actions"
        className="flex flex-wrap items-center gap-2"
        role="group"
      >
        {completed ? null : (
          <Link
            className={buttonVariants({ variant: editVariant })}
            to={editPath}
          >
            <Pencil aria-hidden="true" size={14} />
            Edit automation
          </Link>
        )}
        {canPause ? (
          <>
            <Button
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
                render={<Button aria-label="About pausing" size="icon" />}
              >
                <CircleHelp aria-hidden="true" size={16} />
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                aria-label="About pausing"
              >
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                focusableWhenDisabled
                aria-label="Delete automation"
                size="icon"
                variant="danger"
                onClick={(event) => onDelete(event.currentTarget)}
                disabled={mutation.isPending}
              >
                <Trash2 aria-hidden="true" size={16} />
              </Button>
            }
          />
          <TooltipContent size="compact">Delete automation</TooltipContent>
        </Tooltip>
      </div>
      {mutation.error ? (
        <div className="max-w-sm">
          <FormNotice tone="error" title="Could not update this automation.">
            {mutation.error instanceof DashboardApiError
              ? (mutation.error.apiError ?? "Try again.")
              : mutation.error.message}
          </FormNotice>
        </div>
      ) : null}
    </div>
  );
}
