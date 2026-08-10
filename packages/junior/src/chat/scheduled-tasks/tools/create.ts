import { logInfo } from "@/chat/logging";
import { completeText } from "@/chat/pi/client";
import {
  resolveTaskTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  scheduleIntentSchema,
} from "../schedule-intent";
import { scheduledTaskAttributes } from "../telemetry";
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
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Create a one-time or recurring Junior task in the active Slack conversation when the user asks Junior to do work later or repeatedly.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        task: z.string().min(1).max(4000),
        title: z
          .string()
          .trim()
          .min(1)
          .max(SHORT_TITLE_MAX_LENGTH)
          .nullable()
          .describe(
            "Optional short display title. Omit or use null to generate one from the task instruction.",
          )
          .optional(),
        schedule: scheduleIntentSchema.describe(
          "When the task runs. The scheduler computes the exact next run from this intent and the server clock.",
        ),
        credential_mode: z
          .enum(["creator", "system"])
          .nullable()
          .describe(
            "Use creator to make the task creator's connected credentials available, or system when the creator says not to use them. Omit or use null for the creator default.",
          )
          .optional(),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as {
        task: string;
        title?: string | null;
        schedule: z.input<typeof scheduleIntentSchema>;
        credential_mode?: "creator" | "system" | null;
      };
      const prepared = { ...input };
      if (prepared.title == null) {
        delete prepared.title;
      }
      if (
        prepared.credential_mode === "creator" ||
        prepared.credential_mode === null
      ) {
        delete prepared.credential_mode;
      }
      return prepared;
    },
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

      const creator = await context.users.resolveActor();
      const identity = creator?.identity;
      if (
        !identity ||
        identity.provider !== "slack" ||
        identity.providerTenantId !== destination.teamId ||
        identity.providerSubjectId !== actor.slackUserId
      ) {
        throwToolInputError("Scheduled task creator identity is unavailable.");
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
      const title = await resolveTaskTitle({
        completeText,
        instruction: input.task,
        title: input.title,
      });

      const task: ScheduledTask = {
        id,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: actor,
        creatorIdentityId: identity.id,
        conversationAccess,
        credentialMode: input.credential_mode ?? "creator",
        destination,
        executionActor: SCHEDULED_TASK_SYSTEM_ACTOR,
        nextRunAtMs: compiled.nextRunAtMs,
        originalRequest: context.userText,
        schedule: compiled.schedule,
        status: "active",
        task: {
          text: input.task,
        },
        ...(title ? { title } : {}),
      };

      const committed = await store.createTask(task);
      if (
        !sameDestination(committed, destination) ||
        committed.createdBy.slackUserId !== actor.slackUserId
      ) {
        throwToolInputError("Scheduled task operation identity is invalid.");
      }
      logInfo(
        "scheduled_task.create.completed",
        scheduledTaskAttributes(committed),
      );
      return scheduleTaskToolResult(
        "slackScheduleCreateTask",
        compactTask(committed),
      );
    },
  });
}
