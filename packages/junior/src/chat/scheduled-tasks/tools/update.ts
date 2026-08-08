import { completeText } from "@/chat/pi/client";
import { generateShortTitle } from "@/chat/services/short-title";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  scheduleIntentSchema,
} from "../schedule-intent";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  getDefaultScheduleTimezone,
  getWritableTask,
  normalizeStatus,
  requireActor,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that edits a scheduled task in the active Slack conversation. */
export function createSlackScheduleUpdateTaskTool(
  context: SchedulerToolContext,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Edit, reschedule, unblock, or change credential use for an existing Junior scheduled task in the active Slack conversation.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        task_id: z
          .string()
          .min(1)
          .describe(
            "ID of the task to update. Must be from this active Slack conversation.",
          ),
        task: z.string().min(1).max(4000).optional(),
        schedule: scheduleIntentSchema
          .describe(
            "Complete replacement schedule when rescheduling. Omit for task, status, or credential-only changes; the scheduler computes the next run.",
          )
          .nullable()
          .optional(),
        status: z
          .enum(["active", "blocked"])
          .describe(
            "Set to active to clear a blocked task, or blocked when dispatch cannot continue.",
          )
          .optional(),
        credential_mode: z
          .enum(["system", "creator"])
          .nullable()
          .describe(
            "Set creator to make the task's original creator credentials available, or system to disable them. Creator always means the task's created_by actor, never the current requester. Only that original creator may enable creator mode. Omit or use null to leave unchanged.",
          )
          .optional(),
      })
      .strict(),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async (input) => {
      const lookup = await getWritableTask({
        context,
        taskId: input.task_id,
      });
      if (lookup.status === "completed") {
        throwToolInputError(
          "Completed scheduled tasks cannot be updated. Create a new task instead.",
        );
      }
      const actor = requireActor(context, lookup.destination);
      const isCreator = actor.slackUserId === lookup.createdBy.slackUserId;
      if (input.credential_mode === "creator" && !isCreator) {
        throwToolInputError(
          "Only the scheduled task creator can enable creator credential use.",
        );
      }

      const nowMs = context.now?.() ?? Date.now();
      let compiled;
      if (input.schedule) {
        try {
          compiled = compileScheduleIntent({
            defaultTimezone:
              lookup.schedule.timezone || getDefaultScheduleTimezone(),
            intent: input.schedule,
            nowMs,
          });
        } catch (error) {
          if (error instanceof ScheduleIntentError) {
            throwToolInputError(error.message);
          }
          throw error;
        }
      }
      const nextRunAtMs = compiled?.nextRunAtMs ?? lookup.nextRunAtMs;

      const status = normalizeStatus(input.status);
      if (input.status && !status) {
        throwToolInputError("status must be active or blocked.");
      }
      if (status === "active" && !nextRunAtMs) {
        throwToolInputError(
          "Active scheduled tasks require a schedule with a future occurrence.",
        );
      }
      const nextStatus = status ?? lookup.status;
      // Another actor changing executable text revokes creator delegation.
      const credentialMode =
        input.task !== undefined &&
        input.task !== lookup.task.text &&
        !isCreator
          ? "system"
          : (input.credential_mode ?? lookup.credentialMode);

      const nextInstruction =
        input.task !== undefined ? input.task : lookup.task.text;
      const instructionChanged = nextInstruction !== lookup.task.text;
      const next: ScheduledTask = {
        ...lookup,
        credentialMode,
        updatedAtMs: nowMs,
        nextRunAtMs,
        runNowAtMs:
          nextStatus === "active" && !compiled ? lookup.runNowAtMs : undefined,
        status: nextStatus,
        statusReason:
          nextStatus === "blocked" ? lookup.statusReason : undefined,
        schedule: compiled?.schedule ?? lookup.schedule,
        task: { text: nextInstruction },
      };
      if (instructionChanged) {
        const title = await generateShortTitle({
          completeText,
          kind: "task",
          sourceText: nextInstruction,
        });
        if (title) next.title = title;
        else delete next.title;
      }

      await schedulerStore(context).saveTask(next);
      return scheduleTaskToolResult(
        "slackScheduleUpdateTask",
        compactTask(next),
      );
    },
  });
}
