import { definePluginTool } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  scheduleIntentSchema,
} from "../schedule-intent";
import type { ScheduledTask } from "../types";
import { SchedulerOperationConflictError } from "../store";
import {
  buildTaskMutationIdentity,
  compactTask,
  getDefaultScheduleTimezone,
  normalizeStatus,
  requireActiveConversation,
  requireActor,
  sameDestination,
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
  return definePluginTool({
    description:
      "Edit, pause, resume, reschedule, or change credential use for an existing Junior scheduled task in the active Slack conversation.",
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
          .enum(["active", "paused", "blocked"])
          .describe(
            "Set to active, paused, or blocked to resume, pause, or block the task.",
          )
          .optional(),
        credential_mode: z
          .enum(["system", "creator"])
          .nullable()
          .describe(
            "Set creator only when the current actor is the task creator and explicitly authorizes future scheduled credential use. Set system to disable delegation.",
          )
          .optional(),
      })
      .strict(),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async (input, options) => {
      const destination = requireActiveConversation(context);
      const actor = requireActor(context, destination);
      const mutation = buildTaskMutationIdentity({
        actor,
        destination,
        input,
        taskId: input.task_id,
        toolCallId: options.toolCallId,
      });
      const nowMs = context.now?.() ?? Date.now();
      let committed: ScheduledTask;
      try {
        committed = await schedulerStore(context).applyTaskMutation({
          ...mutation,
          taskId: input.task_id,
          update: (lookup) => {
            if (!lookup || lookup.status === "deleted") {
              throwToolInputError(
                "Scheduled task was not found in the active Slack conversation.",
              );
            }
            if (!sameDestination(lookup, destination)) {
              throwToolInputError(
                "Scheduled task can only be managed from the Slack destination where it was created.",
              );
            }
            const isCreator =
              actor.slackUserId === lookup.createdBy.slackUserId;
            if (input.credential_mode === "creator" && !isCreator) {
              throwToolInputError(
                "Only the scheduled task creator can enable creator credential use.",
              );
            }

            const compiled = input.schedule
              ? compileScheduleIntent({
                  defaultTimezone:
                    lookup.schedule.timezone || getDefaultScheduleTimezone(),
                  intent: input.schedule,
                  nowMs,
                })
              : undefined;
            const nextRunAtMs = compiled?.nextRunAtMs ?? lookup.nextRunAtMs;

            const status = normalizeStatus(input.status);
            if (input.status && !status) {
              throwToolInputError("status must be active, paused, or blocked.");
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

            return {
              ...lookup,
              credentialMode,
              updatedAtMs: nowMs,
              nextRunAtMs,
              runNowAtMs:
                nextStatus === "active" && !compiled
                  ? lookup.runNowAtMs
                  : undefined,
              status: nextStatus,
              statusReason:
                nextStatus === "blocked" ? lookup.statusReason : undefined,
              schedule: compiled?.schedule ?? lookup.schedule,
              task: input.task ? { text: input.task } : lookup.task,
            };
          },
        });
      } catch (error) {
        if (error instanceof ScheduleIntentError) {
          throwToolInputError(error.message);
        }
        if (error instanceof SchedulerOperationConflictError) {
          throwToolInputError("Scheduled task operation identity is invalid.");
        }
        throw error;
      }

      return scheduleTaskToolResult(
        "slackScheduleUpdateTask",
        compactTask(committed),
      );
    },
  });
}
