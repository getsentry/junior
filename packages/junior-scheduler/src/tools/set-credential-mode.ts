import { definePluginTool } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  compactTask,
  getWritableTask,
  requireActor,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that changes only an existing task's credential mode. */
export function createSlackScheduleSetCredentialModeTool(
  context: SchedulerToolContext,
) {
  return definePluginTool({
    approvalMode: "approve",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Change whether an existing Junior scheduled task may use its creator's connected credentials. This changes only credential availability, never the task text, schedule, status, or destination. Only the task creator may set creator mode; use system when credential use is declined.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        task_id: z
          .string()
          .min(1)
          .describe(
            "ID of the task to change. Must be from this active Slack conversation.",
          ),
        credential_mode: z.enum(["system", "creator"]),
      })
      .strict(),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async (input) => {
      const task = await getWritableTask({
        context,
        taskId: input.task_id,
      });
      const actor = requireActor(context, task.destination);
      if (
        input.credential_mode === "creator" &&
        actor.slackUserId !== task.createdBy.slackUserId
      ) {
        throwToolInputError(
          "Only the scheduled task creator can enable creator credential use.",
        );
      }

      const next = {
        ...task,
        credentialMode: input.credential_mode,
        updatedAtMs: context.now?.() ?? Date.now(),
      };
      await schedulerStore(context).saveTask(next);
      return scheduleTaskToolResult(
        "slackScheduleSetCredentialMode",
        compactTask(next),
      );
    },
  });
}
