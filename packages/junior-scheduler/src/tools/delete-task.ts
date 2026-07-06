import { definePluginTool } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  getWritableTask,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that removes a scheduled task from the active Slack conversation. */
export function createSlackScheduleDeleteTaskTool(
  context: SchedulerToolContext,
) {
  return definePluginTool({
    description:
      "Delete one scheduled Junior task from the active Slack conversation. Use only task IDs returned for this conversation. Do not delete schedules from threads, other channels, or another user's DM.",
    executionMode: "sequential",
    inputSchema: z.object({
      task_id: z
        .string()
        .min(1)
        .describe(
          "ID of the task to delete. Must be from this active Slack conversation.",
        ),
    }),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async ({ task_id }) => {
      const lookup = await getWritableTask({ context, taskId: task_id });

      const next: ScheduledTask = {
        ...lookup,
        updatedAtMs: Date.now(),
        status: "deleted",
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
      };

      await schedulerStore(context).saveTask(next);
      return scheduleTaskToolResult(
        "slackScheduleDeleteTask",
        compactTask(next),
      );
    },
  });
}
