import { isAutomationCreator } from "@/chat/automations/creator";
import {
  automationSearchInputSchema,
  requireToolCaller,
  searchToolAutomations,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { getDb } from "@/chat/db";
import { readScheduledAutomations } from "../tasks";
import {
  compactTask,
  scheduleListToolResult,
  scheduleListToolResultSchema,
} from "../tool-support";

/**
 * Create a tool that searches scheduled automations with the dashboard
 * Automations search. It finds the same automations as the dashboard, and
 * also the automations that deliver to this Conversation.
 */
export function createSearchScheduledAutomationsTool(
  context: AutomationToolContext,
) {
  return zodTool({
    description:
      'Search scheduled automations. It finds the requester\'s automations, automations in public channels, and automations that deliver to this conversation. Use scope "current_conversation" for this conversation and "mine" for the requester\'s own. Each result says whether the requester is the creator.',
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: automationSearchInputSchema,
    outputSchema: scheduleListToolResultSchema,
    execute: async (input) => {
      const caller = await requireToolCaller(context);
      const { ids, truncated } = await searchToolAutomations(
        context,
        caller,
        "scheduled",
        input,
      );
      const tasks = await readScheduledAutomations(getDb(), ids);
      return scheduleListToolResult({
        automations: tasks.map((task) =>
          compactTask(task, isAutomationCreator(caller.viewer, task)),
        ),
        truncated,
      });
    },
  });
}
