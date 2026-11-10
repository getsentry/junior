import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverDescription,
} from "../../components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { Link } from "react-router";
import { CircleHelp, Pencil, Trash2 } from "lucide-react";
import type { AutomationSummary } from "@sentry/junior/api/schema";
import { Button, buttonVariants } from "../../components/ui/button";
import { FormNotice } from "../../components/FormNotice";
import { DashboardApiError } from "../../http";
import { useAutomationLifecycle } from "./useAutomationLifecycle";

/**
 * Header actions for one Automation: Edit, Pause or Resume, and Delete.
 * Lifecycle actions re-read the revision before they apply.
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
  const completed = automation.status === "completed";
  const paused = automation.status === "paused";
  const blocked = automation.status === "blocked";
  const canPause = !completed;
  const action = paused || blocked ? "resume" : "pause";
  const mutation = useAutomationLifecycle(automation, action);
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
