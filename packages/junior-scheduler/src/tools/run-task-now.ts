import { definePluginTool } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  getWritableTask,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that marks an existing scheduled task due immediately. */
export function createSlackScheduleRunTaskNowTool(
  context: SchedulerToolContext,
) {
  return definePluginTool({
    description:
      "Queue an existing active scheduled Junior task to run as soon as possible, without changing its cadence. Use when the user asks to run an existing scheduled task now. Use only task IDs returned for this conversation.",
    executionMode: "sequential",
    inputSchema: z.object({
      task_id: z
        .string()
        .min(1)
        .describe(
          "ID of the active task to run now. Must be from this active Slack conversation.",
        ),
    }),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async ({ task_id }) => {
      const lookup = await getWritableTask({ context, taskId: task_id });
      if (lookup.status !== "active") {
        throwToolInputError(
          "Scheduled task must be active before it can be run now. Resume the task first if you want it to run.",
        );
      }

      const nowMs = Date.now();
      const next: ScheduledTask = {
        ...lookup,
        updatedAtMs: nowMs,
        runNowAtMs: nowMs,
      };

      await schedulerStore(context).saveTask(next);
      return scheduleTaskToolResult(
        "slackScheduleRunTaskNow",
        compactTask(next),
      );
    },
  });
}
