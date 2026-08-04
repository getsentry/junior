import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import {
  compactTask,
  MAX_LISTED_TASKS,
  requireActiveConversation,
  sameDestination,
  scheduleListToolResult,
  scheduleListToolResultSchema,
  schedulerStore,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that lists scheduled tasks for the active Slack conversation. */
export function createSlackScheduleListTasksTool(
  context: SchedulerToolContext,
) {
  return zodTool({
    description:
      "List scheduled Junior tasks for the active Slack conversation. Use when the user asks what is scheduled here, or when task IDs are needed before editing, deleting, or running schedules. Only manages tasks for the active Slack DM or channel.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z.object({}),
    outputSchema: scheduleListToolResultSchema,
    execute: async () => {
      const destination = requireActiveConversation(context);

      const tasks = await schedulerStore(context).listTasksForTeam(
        destination.teamId,
      );
      const matching = tasks.filter((task) =>
        sameDestination(task, destination),
      );
      const visible = matching.slice(0, MAX_LISTED_TASKS).map(compactTask);

      return scheduleListToolResult({
        target: "slackScheduleListTasks",
        tasks: visible,
        truncated: matching.length > visible.length,
      });
    },
  });
}
