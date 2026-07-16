import { definePluginTool } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { SCHEDULED_TASK_SYSTEM_ACTOR } from "../types";
import type { ScheduledTask } from "../types";
import {
  buildRecurrence,
  buildTaskId,
  compactTask,
  getConversationAccess,
  getDefaultScheduleTimezone,
  isValidTimeZone,
  parseNextRunAtMs,
  requireActiveConversation,
  requireActor,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  throwToolInputError,
  validateCreateScheduleKind,
  validateRecurringFrequencyLimit,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that stores a scheduled task for the active Slack context. */
export function createSlackScheduleCreateTaskTool(
  context: SchedulerToolContext,
) {
  return definePluginTool({
    description:
      "Create a one-time or recurring Junior task in the active Slack conversation. For one-time reminders or one-time scheduled work, omit recurrence entirely; never choose a default recurrence. Use only when the user explicitly asks Junior to do work later or on a recurring cadence. Do not create scheduled polling tasks to watch provider resources when a subscribable tool result can deliver the requested events. Only manage tasks for the active Slack DM or channel; never target threads, other channels, or another user's DM. Set credential_mode to creator only when the current user explicitly authorizes future scheduled use of their connected credentials. If connected-credential use is needed but authorization is ambiguous, ask before creating the task. Otherwise omit credential_mode and use system credentials. When the task, schedule, destination, and credential mode are clear, create it without another confirmation.",
    executionMode: "sequential",
    inputSchema: z.object({
      task: z.string().min(1).max(4000),
      schedule: z.string().min(1).max(300),
      schedule_kind: z
        .enum(["one_off", "recurring"])
        .describe(
          "Required schedule classification. Use one_off for one-time reminders or one-time scheduled work. Use recurring only when the user explicitly asks for a repeating schedule.",
        ),
      timezone: z
        .string()
        .min(1)
        .max(80)
        .describe(
          "IANA timezone, e.g. 'America/Los_Angeles'. Defaults to the channel's configured timezone.",
        )
        .optional(),
      next_run_at: z
        .string()
        .min(1)
        .describe(
          "Exact next run time as an ISO timestamp, computed from the user's requested schedule.",
        )
        .optional(),
      recurrence: z
        .enum(["daily", "weekly", "monthly", "yearly"])
        .nullable()
        .describe(
          "Required when schedule_kind is recurring. Omit when schedule_kind is one_off. Recurring tasks run at most once per day: use daily, weekly, monthly, or yearly only.",
        )
        .optional(),
      credential_mode: z
        .enum(["system", "creator"])
        .nullable()
        .describe(
          "Use creator only when the current user explicitly authorizes future scheduled use of their connected credentials. Omit or use system otherwise.",
        )
        .optional(),
    }),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async (input) => {
      const destination = requireActiveConversation(context);
      const actor = requireActor(context, destination);

      const nowMs = Date.now();
      const timezone = input.timezone ?? getDefaultScheduleTimezone();
      validateCreateScheduleKind(input);
      validateRecurringFrequencyLimit(input);
      if (!isValidTimeZone(timezone)) {
        throwToolInputError("timezone must be a valid IANA time zone.");
      }
      const nextRunAtMs = parseNextRunAtMs(input.next_run_at);
      if (!nextRunAtMs) {
        throwToolInputError("Provide next_run_at as a valid ISO timestamp.");
      }
      const recurrence = buildRecurrence({
        input,
        nextRunAtMs,
        timezone,
      });
      const conversationAccess = getConversationAccess(
        destination,
        context.source,
      );

      const task: ScheduledTask = {
        id: buildTaskId(),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: actor,
        conversationAccess,
        credentialMode: input.credential_mode ?? "system",
        destination,
        executionActor: SCHEDULED_TASK_SYSTEM_ACTOR,
        nextRunAtMs,
        originalRequest: context.userText,
        schedule: {
          description: input.schedule,
          timezone,
          kind: recurrence ? "recurring" : "one_off",
          recurrence,
        },
        status: "active",
        task: {
          text: input.task,
        },
      };

      await schedulerStore(context).saveTask(task);
      return scheduleTaskToolResult(
        "slackScheduleCreateTask",
        compactTask(task),
      );
    },
  });
}
