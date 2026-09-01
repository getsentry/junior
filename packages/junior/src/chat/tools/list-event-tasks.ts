import { z } from "zod";
import { getDb } from "@/chat/db";
import { listEventTasksForTeam } from "@/chat/event-tasks/store";
import {
  compactEventTask,
  eventTaskListToolResultSchema,
  eventTaskMatchesDestination,
  requireEventTaskSlackContext,
} from "@/chat/event-tasks/tool-support";
import type { ResourceEventCatalog } from "@/chat/resource-events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const MAX_LISTED_EVENT_TASKS = 50;

/** Create the core tool that lists event tasks for this destination. */
export function createListEventTasksTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "List event tasks for the current destination. A false triggerAvailable value means the task remains stored but its plugin event is not currently enabled.",
    inputSchema: z.object({}).strict(),
    outputSchema: eventTaskListToolResultSchema,
    async execute() {
      const { destination } = requireEventTaskSlackContext(context);
      const matching = (
        await listEventTasksForTeam(getDb(), destination.teamId)
      ).filter((task) => eventTaskMatchesDestination(task, destination));
      const tasks = matching
        .slice(0, MAX_LISTED_EVENT_TASKS)
        .map((task) => compactEventTask(task, catalog));
      return {
        tasks,
        truncated: matching.length > tasks.length,
      };
    },
  });
}
