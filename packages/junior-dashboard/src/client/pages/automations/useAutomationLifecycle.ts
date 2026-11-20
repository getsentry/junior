import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationListItem,
} from "@sentry/junior/api/schema";

import { useToastManager } from "../../components/ui/toast";
import { fetchDashboardJson, post } from "../../http";
import { refreshChangedAutomation } from "../../review-desk/inboxQueries";

/**
 * Pause or resume one Automation, then refresh every Automation list. It
 * re-reads the revision first, so it never applies the opposite action
 * after another surface changed the lifecycle.
 */
export function useAutomationLifecycle(
  automation: AutomationListItem,
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
      await refreshChangedAutomation(queryClient, updated);
      // The new state shows on the page. Only a resume that did not take
      // needs saying.
      if (updated.status === "blocked")
        toast.add({
          title: "Automation is still blocked",
          description: "Fix the reported requirement before resuming again.",
          type: "warning",
        });
    },
  });
}
