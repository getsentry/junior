import { definePluginTool } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { ScheduledTask } from "../types";
import {
  buildRecurrence,
  compactTask,
  getWritableTask,
  isValidTimeZone,
  normalizeStatus,
  parseNextRunAtMs,
  requireActor,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  shouldRebuildRecurrence,
  throwToolInputError,
  validateRecurringFrequencyLimit,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that edits a scheduled task in the active Slack conversation. */
export function createSlackScheduleUpdateTaskTool(
  context: SchedulerToolContext,
) {
  return definePluginTool({
    description:
      "Edit, pause, resume, reschedule, or change credential use for an existing Junior scheduled task in the active Slack conversation. Use only task IDs returned for this conversation. Do not move scheduled tasks across conversations. Set credential_mode to creator only when the task creator explicitly authorizes future scheduled use of their connected credentials. If creator credential use is requested but authorization is ambiguous, ask before enabling it. If another user changes the executable task text, creator credential use is cleared automatically.",
    executionMode: "sequential",
    inputSchema: z.object({
      task_id: z
        .string()
        .min(1)
        .describe(
          "ID of the task to update. Must be from this active Slack conversation.",
        ),
      task: z.string().min(1).max(4000).optional(),
      schedule: z.string().min(1).max(300).optional(),
      timezone: z.string().min(1).max(80).optional(),
      next_run_at: z
        .string()
        .min(1)
        .describe("Exact ISO timestamp when changing the next run time.")
        .optional(),
      recurrence: z
        .enum(["daily", "weekly", "monthly", "yearly"])
        .nullable()
        .describe(
          "Provide only for repeating schedules. Omit for one-time requests. Set to null to convert a recurring task to one-time.",
        )
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
    }),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async (input) => {
      const lookup = await getWritableTask({
        context,
        taskId: input.task_id,
      });
      const actor = requireActor(context, lookup.destination);
      const isCreator = actor.slackUserId === lookup.createdBy.slackUserId;
      if (input.credential_mode === "creator" && !isCreator) {
        throwToolInputError(
          "Only the scheduled task creator can enable creator credential use.",
        );
      }

      const timezone = input.timezone ?? lookup.schedule.timezone;
      validateRecurringFrequencyLimit(input);
      if (!isValidTimeZone(timezone)) {
        throwToolInputError("timezone must be a valid IANA time zone.");
      }
      const parsedNextRunAtMs = parseNextRunAtMs(input.next_run_at);
      const nextRunAtMs = input.next_run_at
        ? parsedNextRunAtMs
        : lookup.nextRunAtMs;
      if (input.next_run_at && !nextRunAtMs) {
        throwToolInputError("Provide next_run_at as a valid ISO timestamp.");
      }

      const status = normalizeStatus(input.status);
      if (input.status && !status) {
        throwToolInputError("status must be active, paused, or blocked.");
      }
      if (status === "active" && !nextRunAtMs) {
        throwToolInputError(
          "Active scheduled tasks require next_run_at when no next run is stored.",
        );
      }
      const recurrence = shouldRebuildRecurrence(input)
        ? buildRecurrence({
            existing: lookup.schedule.recurrence,
            input,
            nextRunAtMs,
            timezone,
          })
        : lookup.schedule.recurrence;
      const nextStatus = status ?? lookup.status;
      // Another actor changing executable text revokes creator delegation.
      const credentialMode =
        input.task !== undefined &&
        input.task !== lookup.task.text &&
        !isCreator
          ? "system"
          : (input.credential_mode ?? lookup.credentialMode);

      const next: ScheduledTask = {
        ...lookup,
        credentialMode,
        updatedAtMs: Date.now(),
        nextRunAtMs,
        runNowAtMs: nextStatus === "active" ? lookup.runNowAtMs : undefined,
        status: nextStatus,
        statusReason:
          nextStatus === "blocked" ? lookup.statusReason : undefined,
        schedule: {
          ...lookup.schedule,
          description: input.schedule ?? lookup.schedule.description,
          timezone,
          kind: recurrence ? "recurring" : "one_off",
          recurrence,
        },
        task: input.task ? { text: input.task } : lookup.task,
      };

      await schedulerStore(context).saveTask(next);
      return scheduleTaskToolResult(
        "slackScheduleUpdateTask",
        compactTask(next),
      );
    },
  });
}
