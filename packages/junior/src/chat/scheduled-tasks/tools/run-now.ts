import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveScheduledTask } from "../tasks";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  getWritableTask,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that marks an existing scheduled task due immediately. */
export function createSlackScheduleRunTaskNowTool(
  context: SchedulerToolContext,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
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
          "Scheduled task must be active before it can be run now.",
        );
      }

      const nowMs = Date.now();
      const next: ScheduledTask = {
        ...lookup,
        updatedAtMs: nowMs,
        runNowAtMs: nowMs,
      };

      await saveScheduledTask(getDb(), next);
      return scheduleTaskToolResult(
        "slackScheduleRunTaskNow",
        compactTask(next),
      );
    },
  });
}
