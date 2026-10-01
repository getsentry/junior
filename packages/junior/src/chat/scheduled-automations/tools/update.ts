import { taskOutcomeInputSchema } from "@/chat/task-outcomes-schema";
import {
  automationTitleSchema,
  automationInstructionSchema,
} from "@/chat/automations/edit-schema";
import { logInfo } from "@/chat/logging";
import { automationRevision } from "@/chat/automations/revision";
import { editScheduledAutomation } from "../edit";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { moveTaskOutcomes, resolveTaskOutcomes } from "@/chat/task-outcomes";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorSchedulerRuns } from "@/db/schema/scheduled-automations";
import { readScheduledAutomation, saveScheduledAutomation } from "../tasks";
import { scheduleIntentSchema } from "../schedule-intent";
import { scheduledAutomationAttributes } from "../telemetry";
import {
  getConversationAccess,
  normalizeStatus,
  requireActiveChannel,
  requireActor,
  sameDestination,
  scheduleAutomationToolResult,
  scheduleAutomationToolResultSchema,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that edits a scheduled automation, including moving it here. */
export function createSlackScheduleUpdateAutomationTool(
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
      'Update a scheduled automation. Set destination to "here" to move it to the active Slack channel.',
    executionMode: "sequential",
    inputSchema: z
      .object({
        automationId: z
          .string()
          .min(1)
          .describe(
            "Scheduled automation ID returned by slackScheduleListAutomations.",
          ),
        title: automationTitleSchema.optional(),
        instruction: automationInstructionSchema.optional(),
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
          .literal("here")
          .nullable()
          .describe(
            'Set to "here" to move the creator\'s task into the active Slack channel. Omit to keep its destination.',
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
      const activeDestination = requireActiveChannel(context);
      const actor = requireActor(context, activeDestination);
      const db = getDb();
      const lookup = await readScheduledAutomation(db, input.automationId);
      if (!lookup || lookup.status === "deleted") {
        throwToolInputError("Scheduled automation was not found.");
      }
      if (lookup.status === "completed") {
        throwToolInputError(
          "Completed scheduled automations cannot be updated. Create a new automation instead.",
        );
      }
      if (lookup.destination.platform !== "slack") {
        throwToolInputError("Scheduled automation destination is invalid.");
      }
      if (lookup.destination.teamId !== activeDestination.teamId) {
        throwToolInputError(
          "Scheduled automations can only be managed within the same Slack workspace.",
        );
      }

      const moveDestination = input.destination != null;
      const requestedDestination = activeDestination;
      const alreadyHere = sameDestination(lookup, activeDestination);
      const isCreator = actor.slackUserId === lookup.createdBy.slackUserId;

      if (!alreadyHere && !moveDestination) {
        throwToolInputError(
          'Scheduled automation can only be managed from the Slack destination where it currently delivers. Set destination to "here" to move it into this conversation.',
        );
      }
      if (moveDestination && !isCreator) {
        throwToolInputError(
          "Only the scheduled automation creator can move this task.",
        );
      }
      if (input.credentialMode === "creator" && !isCreator) {
        throwToolInputError(
          "Only the scheduled automation creator can enable creator credential use.",
        );
      }
      // TODO(dcramer): Allow public Automation members to change outcomes after
      // shared policy or the web UI can authorize the new Destination safely.
      if (input.outcomes !== undefined && !isCreator) {
        throwToolInputError(
          "Only the scheduled automation creator can change message destinations.",
        );
      }

      const changingDestination = moveDestination && !alreadyHere;
      if (changingDestination) {
        const incompleteRuns = await db
          .select({ id: juniorSchedulerRuns.id })
          .from(juniorSchedulerRuns)
          .where(
            and(
              eq(juniorSchedulerRuns.taskId, lookup.id),
              inArray(juniorSchedulerRuns.status, ["pending", "running"]),
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
          activeDestination,
          context.source,
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
          actor.slackUserId,
        );
      }

      const committed = await saveScheduledAutomation(
        db,
        next,
        automationRevision(lookup),
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
        actor.slackUserId,
      );
    },
  });
}
