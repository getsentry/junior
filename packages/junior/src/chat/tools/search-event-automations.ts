import { isAutomationCreator } from "@/chat/automations/creator";
import {
  automationSearchInputSchema,
  automationToolContext,
  requireToolCaller,
  searchToolAutomations,
} from "@/chat/automations/tool-access";
import { getDb } from "@/chat/db";
import { getEventAutomation } from "@/chat/event-automations/store";
import {
  compactEventAutomation,
  eventAutomationListToolResultSchema,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/**
 * Create the core tool that searches event automations with the dashboard
 * Automations search, like `searchScheduledAutomations`.
 */
export function createSearchEventAutomationsTool(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      'Search event automations. It finds the requester\'s automations, automations in public channels, and automations that deliver to this conversation. Use scope "current_conversation" for this conversation and "mine" for the requester\'s own. Each result says whether the requester is the creator (isCreator); only the creator can change its credential use. Warn when trigger.available is false and explain trigger.problems: the automation stays stored, but a plugin no longer supports its resource type, an event, or a filter. Update the trigger to fix it.',
    inputSchema: automationSearchInputSchema,
    outputSchema: eventAutomationListToolResultSchema,
    async execute(input) {
      const taskContext = automationToolContext(context);
      const caller = await requireToolCaller(taskContext);
      const { ids, truncated } = await searchToolAutomations(
        taskContext,
        caller,
        "event",
        input,
      );
      const db = getDb();
      const tasks = await Promise.all(
        ids.map((id) => getEventAutomation(db, id)),
      );
      return {
        automations: tasks.flatMap((task) =>
          task
            ? [
                compactEventAutomation(
                  task,
                  catalog,
                  isAutomationCreator(caller.viewer, task),
                ),
              ]
            : [],
        ),
        truncated,
      };
    },
  });
}
