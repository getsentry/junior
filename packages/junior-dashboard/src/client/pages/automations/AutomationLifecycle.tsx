import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { FormNotice } from "../../components/FormNotice";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";

/** Explain lifecycle separately from the last execution and offer creator-only actions. */
export function AutomationLifecycle({
  automation,
}: {
  automation: AutomationSummary;
}) {
  const queryClient = useQueryClient();
  const completed = automation.status === "completed";
  const paused = automation.status === "paused";
  const blocked = automation.status === "blocked";
  const unavailable =
    automation.kind === "event" && !automation.triggerAvailable;
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
  return (
    <div className="grid gap-3 text-sm">
      <p className="m-0 text-dashboard-text-muted">
        {completed
          ? "Completed. This automation will not run again."
          : paused
            ? "Paused by a person. Future triggers will not start work."
            : blocked
              ? "Future runs are blocked. Resolve the requirement below before resuming."
              : unavailable
                ? "The trigger is unavailable. Enable its plugin or edit the trigger to receive events."
                : "Future triggers can start work."}
      </p>
      {automation.kind === "scheduled" && automation.statusReason ? (
        <p className="m-0 break-words text-amber-300">
          {automation.statusReason}
        </p>
      ) : null}
      {paused && unavailable ? (
        <p className="m-0 text-dashboard-text-muted">
          The trigger is also unavailable. Resuming will not enable its plugin.
        </p>
      ) : null}
      {automation.lastRunStatus === "failed" ||
      automation.lastRunStatus === "blocked" ? (
        <p className="m-0 text-dashboard-text-muted">
          Last run {automation.lastRunStatus}. This does not by itself stop
          future work.{" "}
          <Link
            className="text-dashboard-text underline"
            to={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`}
          >
            Inspect executions
          </Link>
        </p>
      ) : null}
      {automation.ownedByViewer && !completed ? (
        <>
          <p className="m-0 text-xs text-dashboard-text-muted">
            Pause does not cancel work already claimed or started. Resume uses
            future schedule times and newly received events. Missed triggers are
            not replayed.
          </p>
          {paused &&
          automation.kind === "scheduled" &&
          automation.statusReason ? (
            <p className="m-0 text-xs text-dashboard-text-muted">
              Resuming removes the pause but keeps the unresolved block.
            </p>
          ) : null}
          <div>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending
                ? "Updating…"
                : action === "pause"
                  ? "Pause automation"
                  : "Resume automation"}
            </Button>
          </div>
        </>
      ) : null}
      {mutation.isSuccess ? (
        <p role="status" className="m-0 text-dashboard-text-muted">
          {mutation.data.status === "paused"
            ? "Automation paused."
            : mutation.data.status === "blocked"
              ? "Pause removed. The automation is still blocked."
              : "Automation resumed. Missed triggers will not be replayed."}
        </p>
      ) : null}
      {mutation.error ? (
        <FormNotice tone="error" title="Automation could not be updated.">
          {mutation.error instanceof DashboardApiError
            ? (mutation.error.apiError ?? "Try again.")
            : mutation.error.message}
        </FormNotice>
      ) : null}
    </div>
  );
}
