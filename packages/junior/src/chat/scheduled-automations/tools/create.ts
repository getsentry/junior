import { logInfo } from "@/chat/logging";
import { completeText } from "@/chat/pi/client";
import { getDb } from "@/chat/db";
import {
  resolveTaskTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { zodTool } from "@/chat/tool-support/zod-tool";
import {
  resolveTaskOutcomes,
  taskOutcomeInputSchema,
  type TaskOutcomeInput,
} from "@/chat/task-outcomes";
import { z } from "zod";
import { createScheduledAutomation, readScheduledAutomation } from "../tasks";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  scheduleIntentSchema,
} from "../schedule-intent";
import { scheduledAutomationAttributes } from "../telemetry";
import { SCHEDULED_AUTOMATION_SYSTEM_ACTOR } from "../types";
import type { ScheduledAutomation } from "../types";
import {
  buildTaskId,
  getConversationAccess,
  getDefaultScheduleTimezone,
  requireActiveConversation,
  requireActor,
  sameDestination,
  scheduleAutomationToolResult,
  scheduleAutomationToolResultSchema,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that stores a scheduled automation for the active Slack context. */
export function createSlackScheduleCreateAutomationTool(
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
        instruction: z.string().min(1).max(4000),
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
        outcomes: z
          .array(taskOutcomeInputSchema)
          .max(5)
          .describe(
            "Successful work is silent by default. Omit this field or use an empty list when the Automation should act through tools without a status message. Add send_message only when the user asks for a reminder, post, digest, summary, or other visible result.",
          )
          .optional(),
        credentialMode: z
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
        instruction: string;
        title?: string | null;
        schedule: z.input<typeof scheduleIntentSchema>;
        outcomes?: TaskOutcomeInput[];
        credentialMode?: "creator" | "system" | null;
      };
      const prepared = { ...input };
      if (prepared.title == null) {
        delete prepared.title;
      }
      if (
        prepared.credentialMode === "creator" ||
        prepared.credentialMode === null
      ) {
        delete prepared.credentialMode;
      }
      return prepared;
    },
    outputSchema: scheduleAutomationToolResultSchema,
    execute: async (input, options) => {
      const destination = requireActiveConversation(context);
      const actor = requireActor(context, destination);
      const id = buildTaskId({
        actor,
        destination,
        toolCallId: options.toolCallId,
      });
      // Replaying a durable tool call returns its original task instead of duplicating it.
      const db = getDb();
      const existing = await readScheduledAutomation(db, id);
      if (existing) {
        if (
          !sameDestination(existing, destination) ||
          existing.createdBy.slackUserId !== actor.slackUserId
        ) {
          throwToolInputError(
            "Scheduled automation operation identity is invalid.",
          );
        }
        return scheduleAutomationToolResult(existing, actor.slackUserId);
      }

      const creator = await context.users.resolveActor();
      const identity = creator?.identity;
      if (
        !identity ||
        identity.provider !== "slack" ||
        identity.providerTenantId !== destination.teamId ||
        identity.providerSubjectId !== actor.slackUserId
      ) {
        throwToolInputError(
          "Scheduled automation creator identity is unavailable.",
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
      const title = await resolveTaskTitle({
        completeText,
        instruction: input.instruction,
        title: input.title,
      });

      const task: ScheduledAutomation = {
        id,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: actor,
        creatorIdentityId: identity.id,
        conversationAccess,
        credentialMode: input.credentialMode ?? "creator",
        destination,
        executionActor: SCHEDULED_AUTOMATION_SYSTEM_ACTOR,
        nextRunAtMs: compiled.nextRunAtMs,
        originalRequest: context.userText,
        schedule: compiled.schedule,
        status: "active",
        outcomes: await resolveTaskOutcomes(
          input.outcomes,
          destination,
          actor.slackUserId,
        ),
        task: {
          text: input.instruction,
        },
        ...(title ? { title } : undefined),
      };

      const committed = await createScheduledAutomation(db, task);
      if (
        !sameDestination(committed, destination) ||
        committed.createdBy.slackUserId !== actor.slackUserId
      ) {
        throwToolInputError(
          "Scheduled automation operation identity is invalid.",
        );
      }
      logInfo(
        "scheduled_automation.create.completed",
        scheduledAutomationAttributes(committed),
      );
      return scheduleAutomationToolResult(committed, actor.slackUserId);
    },
  });
}
