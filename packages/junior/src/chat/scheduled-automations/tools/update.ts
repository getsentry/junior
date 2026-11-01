import { taskOutcomeInputSchema } from "@/chat/task-outcomes-schema";
import {
  automationTitleSchema,
  automationInstructionToolSchema,
} from "@/chat/automations/edit-schema";
import { requireRequesterMention } from "@/chat/automations/requester-mention";
import { logInfo } from "@/chat/logging";
import { automationRevision } from "@/chat/automations/revision";
import { editScheduledAutomation } from "../edit";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { moveTaskOutcomes, resolveTaskOutcomes } from "@/chat/task-outcomes";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { saveScheduledAutomation } from "../tasks";
import { scheduleIntentSchema } from "../schedule-intent";
import { scheduledAutomationAttributes } from "../telemetry";
import { automationEditor } from "@/chat/automations/edit";
import {
  requireToolAutomation,
  requireToolCaller,
  requireToolDestination,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  getConversationAccess,
  normalizeStatus,
  sameDestination,
  scheduleAutomationToolResult,
  scheduleAutomationToolResultSchema,
  throwToolInputError,
} from "../tool-support";

/**
 * Create a tool that edits a scheduled automation, including moving it to
 * this Conversation.
 */
export function createUpdateScheduledAutomationTool(
  context: AutomationToolContext,
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
      'Update a scheduled automation. Anyone in the workspace can update an automation in a public channel. Automations in private channels and DMs can be updated from there or by their creator. Only the creator can enable creator credentials, change outcomes, or move it. A non-creator who changes the instruction or schedule switches it to system credentials. Set destination to "current_conversation" to move it to the channel or DM of this conversation.',
    executionMode: "sequential",
    inputSchema: z
      .object({
        automationId: z
          .string()
          .min(1)
          .describe(
            "Scheduled automation ID returned by searchScheduledAutomations.",
          ),
        title: automationTitleSchema.optional(),
        instruction: automationInstructionToolSchema.optional(),
        schedule: scheduleIntentSchema
          .describe("Complete replacement schedule. Omit to keep it unchanged.")
          .nullable()
          .optional(),
        outcomes: z
          .array(taskOutcomeInputSchema)
          .max(5)
          .describe(
            "Replacement messages to send after successful work. Use an empty list to send nothing. Omit to keep unchanged.",
          )
          .optional(),
        status: z
          .enum(["active", "blocked"])
          .describe(
            "Set active to resume a blocked task, or blocked to stop dispatch.",
          )
          .optional(),
        destination: z
          .literal("current_conversation")
          .nullable()
          .describe(
            'Set to "current_conversation" to move the creator\'s task into the channel or DM of this conversation. Omit to keep its destination.',
          )
          .optional(),
        credentialMode: z
          .enum(["system", "creator"])
          .nullable()
          .describe(
            "Use creator credentials or system credentials. Only the task creator may enable creator mode. Omit to keep unchanged.",
          )
          .optional(),
      })
      .strict(),
    outputSchema: scheduleAutomationToolResultSchema,
    execute: async (input) => {
      const db = getDb();
      const caller = await requireToolCaller(context);
      const candidate = await requireToolAutomation(
        caller,
        "scheduled",
        input.automationId,
      );
      const { task: lookup, ownedByViewer: isCreator } = candidate;
      if (lookup.status === "completed") {
        throwToolInputError(
          "Completed scheduled automations cannot be updated. Create a new automation instead.",
        );
      }

      const moveDestination = input.destination != null;
      if (moveDestination && !isCreator) {
        throwToolInputError(
          "Only the scheduled automation creator can move this task.",
        );
      }
      const requestedDestination = moveDestination
        ? requireToolDestination(context)
        : undefined;
      const alreadyHere =
        requestedDestination !== undefined &&
        sameDestination(lookup, requestedDestination);

      const changingDestination =
        requestedDestination !== undefined && !alreadyHere;
      if (changingDestination) {
        const incompleteRuns = await db
          .select({ id: juniorAutomationRuns.id })
          .from(juniorAutomationRuns)
          .where(
            and(
              eq(juniorAutomationRuns.automationId, lookup.id),
              inArray(juniorAutomationRuns.status, ["pending", "running"]),
            ),
          )
          .limit(1);
        if (incompleteRuns.length > 0) {
          throwToolInputError(
            "Scheduled automation cannot be moved while an occurrence is already running. Try again after the current run finishes.",
          );
        }
      }

      const nowMs = context.now?.() ?? Date.now();
      const status = normalizeStatus(input.status);
      if (input.status && !status)
        throwToolInputError("status must be active or blocked.");
      const instructionChanged =
        input.instruction !== undefined &&
        input.instruction !== lookup.task.text;
      const editor = automationEditor(caller.viewer, candidate);
      if (input.instruction !== undefined && instructionChanged) {
        requireRequesterMention(input.instruction, editor);
      }
      const next = await editScheduledAutomation(
        lookup,
        {
          title: input.title,
          instruction: input.instruction,
          schedule: input.schedule ?? undefined,
          status,
          credentialMode: input.credentialMode ?? undefined,
          // A move resolves outcomes against the new Destination below.
          outcomes: changingDestination ? undefined : input.outcomes,
        },
        isCreator,
        nowMs,
      );
      if (changingDestination) {
        next.destination = requestedDestination;
        next.conversationAccess = getConversationAccess(
          requestedDestination,
          context.visibility,
        );
        next.outcomes =
          input.outcomes === undefined
            ? moveTaskOutcomes(
                lookup.outcomes,
                lookup.destination,
                requestedDestination,
              )
            : await resolveTaskOutcomes(
                input.outcomes,
                requestedDestination,
                lookup.createdBy.slackUserId,
              );
      }

      // A Destination update that already landed is a no-op success.
      if (
        !changingDestination &&
        !instructionChanged &&
        !input.schedule &&
        input.title === undefined &&
        status === undefined &&
        (input.credentialMode === undefined ||
          input.credentialMode === null ||
          input.credentialMode === lookup.credentialMode) &&
        input.outcomes === undefined &&
        moveDestination
      ) {
        return scheduleAutomationToolResult(
          context.conversationId,
          lookup,
          isCreator,
        );
      }

      const committed = await saveScheduledAutomation(
        db,
        next,
        automationRevision(lookup),
        editor,
      );
      if (changingDestination) {
        logInfo(
          "scheduled_automation.move.completed",
          scheduledAutomationAttributes(committed),
        );
      }
      return scheduleAutomationToolResult(
        context.conversationId,
        committed,
        isCreator,
      );
    },
  });
}
