import { definePluginTool } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  scheduleIntentSchema,
} from "../schedule-intent";
import { SCHEDULED_TASK_SYSTEM_ACTOR } from "../types";
import type { ScheduledTask } from "../types";
import {
  buildTaskId,
  compactTask,
  getConversationAccess,
  getDefaultScheduleTimezone,
  requireActiveConversation,
  requireActor,
  sameDestination,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that stores a scheduled task for the active Slack context. */
export function createSlackScheduleCreateTaskTool(
  context: SchedulerToolContext,
) {
  return definePluginTool({
    description:
      "Create a one-time or recurring Junior task in the active Slack conversation when the user asks Junior to do work later or repeatedly.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        task: z.string().min(1).max(4000),
        schedule: scheduleIntentSchema.describe(
          "When the task runs. The scheduler computes the exact next run from this intent and the server clock.",
        ),
        credential_mode: z
          .enum(["system", "creator"])
          .nullable()
          .describe(
            "Use creator only when the current user explicitly authorizes future scheduled use of their connected credentials. Omit or use system otherwise.",
          )
          .optional(),
      })
      .strict(),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async (input, options) => {
      const destination = requireActiveConversation(context);
      const actor = requireActor(context, destination);
      const store = schedulerStore(context);
      const id = buildTaskId({
        actor,
        destination,
        toolCallId: options.toolCallId,
      });
      // Replaying a durable tool call returns its original task instead of duplicating it.
      const existing = await store.getTask(id);
      if (existing) {
        if (
          !sameDestination(existing, destination) ||
          existing.createdBy.slackUserId !== actor.slackUserId
        ) {
          throwToolInputError("Scheduled task operation identity is invalid.");
        }
        return scheduleTaskToolResult(
          "slackScheduleCreateTask",
          compactTask(existing),
        );
      }

      const nowMs = context.now?.() ?? Date.now();
      let compiled;
      try {
        compiled = compileScheduleIntent({
          defaultTimezone: getDefaultScheduleTimezone(),
          intent: input.schedule,
          nowMs,
        });
      } catch (error) {
        if (error instanceof ScheduleIntentError) {
          throwToolInputError(error.message);
        }
        throw error;
      }
      const conversationAccess = getConversationAccess(
        destination,
        context.source,
      );

      const task: ScheduledTask = {
        id,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: actor,
        conversationAccess,
        credentialMode: input.credential_mode ?? "system",
        destination,
        executionActor: SCHEDULED_TASK_SYSTEM_ACTOR,
        nextRunAtMs: compiled.nextRunAtMs,
        originalRequest: context.userText,
        schedule: compiled.schedule,
        status: "active",
        task: {
          text: input.task,
        },
      };

      const committed = await store.createTask(task);
      if (
        !sameDestination(committed, destination) ||
        committed.createdBy.slackUserId !== actor.slackUserId
      ) {
        throwToolInputError("Scheduled task operation identity is invalid.");
      }
      return scheduleTaskToolResult(
        "slackScheduleCreateTask",
        compactTask(committed),
      );
    },
  });
}
