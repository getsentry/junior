import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { Button, ButtonLink } from "../../components/Button";
import { StatusChip } from "../../components/StatusChip";
import { FormNotice } from "../../components/FormNotice";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";

/** Explain lifecycle separately from the last execution and offer creator-only actions. */
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
  const unavailable =
    automation.kind === "event" && !automation.triggerAvailable;
  const canEdit = automation.ownedByViewer && !completed;
  const blockReason =
    automation.kind === "scheduled" ? automation.statusReason : undefined;
  const action = paused || blocked ? "resume" : "pause";
  const mutation = useMutation({
    mutationFn: async () => {
      const path = `/api/automations/${automation.kind}/${encodeURIComponent(automation.id)}`;
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
  const status =
    automation.status === "active" && unavailable
      ? "Trigger unavailable"
      : automation.status;
  const failed =
    automation.lastRunStatus === "failed" ||
    automation.lastRunStatus === "blocked";
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="status" aria-live="polite">
          <StatusChip
            tone={
              paused || completed
                ? "neutral"
                : blocked || unavailable
                  ? "warning"
                  : "success"
            }
          >
            {status}
          </StatusChip>
        </div>
        <div className="flex items-center gap-2">
          <ButtonLink className="min-h-11" to={editPath}>
            {canEdit ? "Edit automation" : "View settings"}
          </ButtonLink>
          {canEdit ? (
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
          ) : null}
        </div>
      </div>
      {blocked || blockReason ? (
        <p className="m-0 break-words text-dashboard-text-muted">
          {blockReason ?? "Check the last run to see what needs fixing."}{" "}
          {paused ? "Fix this before resuming." : "Fix this, then resume."}
        </p>
      ) : null}
      {unavailable ? (
        <p className="m-0 text-dashboard-text-muted">
          This event source is unavailable. Enable its plugin or choose another
          event.
        </p>
      ) : null}
      {failed ? (
        <p className="m-0 text-dashboard-text-muted">
          Last run {automation.lastRunStatus}.
          {automation.status === "active" && !unavailable
            ? " Future runs are still on."
            : ""}{" "}
          <Link
            className="text-dashboard-text underline underline-offset-2"
            to={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`}
          >
            View run history
          </Link>
        </p>
      ) : null}
      {canEdit ? (
        <details className="text-dashboard-text-muted">
          <summary className="w-fit cursor-pointer py-2 text-xs hover:text-dashboard-text focus-visible:outline focus-visible:outline-dashboard-focus">
            About pausing
          </summary>
          <p className="mt-1 mb-0 leading-relaxed">
            Pausing stops new runs. Work already queued or running may finish.
            Resuming skips missed runs and waits for the next scheduled time or
            new event.
            {paused && blockReason
              ? " Removing the pause keeps the block until you fix it and resume again."
              : ""}
          </p>
        </details>
      ) : null}
      {mutation.error ? (
        <FormNotice tone="error" title="Could not update this automation.">
          {mutation.error instanceof DashboardApiError
            ? (mutation.error.apiError ?? "Try again.")
            : mutation.error.message}
        </FormNotice>
      ) : null}
    </div>
  );
}
