import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";

import { useToastManager } from "../../components/ui/toast";
import { fetchDashboardJson, post } from "../../http";

/**
 * Pause or resume one Automation, then refresh every Automation list. It
 * re-reads the revision first, so it never applies the opposite action
 * after another surface changed the lifecycle.
 */
export function useAutomationLifecycle(
  automation: AutomationSummary,
  action: "pause" | "resume",
) {
  const toast = useToastManager();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const path = `/api/automations/${encodeURIComponent(automation.id)}`;
      const current = await fetchDashboardJson(
        automationEditSchema,
        `${path}/edit`,
      );
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
}
