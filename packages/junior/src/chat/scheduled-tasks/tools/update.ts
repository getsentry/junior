import { logInfo } from "@/chat/logging";
import { completeText } from "@/chat/pi/client";
import { generateShortTitle } from "@/chat/services/short-title";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  scheduleIntentSchema,
} from "../schedule-intent";
import { scheduledTaskAttributes } from "../telemetry";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  getConversationAccess,
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

/** Create a tool that edits a scheduled task, including moving it here. */
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
      "Edit, reschedule, unblock, change credential use, or move an existing Junior scheduled task. Same-channel edits stay in the active conversation. To rehome a task into this conversation, set destination to \"here\" (creator only). Do not pass arbitrary destination channel IDs.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        task_id: z
          .string()
          .min(1)
          .describe(
            "ID of the task to update. Same-channel edits use a task from this conversation; destination moves may use a requester-owned task found via slackScheduleListTasks.",
          ),
        task: z.string().min(1).max(4000).optional(),
        schedule: scheduleIntentSchema
          .describe(
            "Complete replacement schedule when rescheduling. Omit for task, status, destination, or credential-only changes; the scheduler computes the next run.",
          )
          .nullable()
          .optional(),
        status: z
          .enum(["active", "blocked"])
          .describe(
            "Set to active to clear a blocked task, or blocked when dispatch cannot continue.",
          )
          .optional(),
        destination: z
          .literal("here")
          .nullable()
          .describe(
            'Move the task into the active Slack conversation. Only the creator may move a task, and only "here" is allowed. Omit or use null to leave the destination unchanged.',
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
      const activeDestination = requireActiveConversation(context);
      const actor = requireActor(context, activeDestination);
      const store = schedulerStore(context);
      const lookup = await store.getTask(input.task_id);
      if (!lookup || lookup.status === "deleted") {
        throwToolInputError("Scheduled task was not found.");
      }
      if (lookup.status === "completed") {
        throwToolInputError(
          "Completed scheduled tasks cannot be updated. Create a new task instead.",
        );
      }
      if (lookup.destination.platform !== "slack") {
        throwToolInputError("Scheduled task destination is invalid.");
      }
      if (lookup.destination.teamId !== activeDestination.teamId) {
        throwToolInputError(
          "Scheduled tasks can only be managed within the same Slack workspace.",
        );
      }

      const moveHere = input.destination === "here";
      const alreadyHere = sameDestination(lookup, activeDestination);
      const isCreator = actor.slackUserId === lookup.createdBy.slackUserId;

      if (!alreadyHere && !moveHere) {
        throwToolInputError(
          "Scheduled task can only be managed from the Slack destination where it currently delivers. Set destination to \"here\" to move it into this conversation.",
        );
      }
      if (moveHere && !isCreator) {
        throwToolInputError(
          "Only the scheduled task creator can move this task.",
        );
      }
      if (input.credential_mode === "creator" && !isCreator) {
        throwToolInputError(
          "Only the scheduled task creator can enable creator credential use.",
        );
      }

      const changingDestination = moveHere && !alreadyHere;
      if (changingDestination) {
        const incompleteRuns = await store.listIncompleteRunsForTasks([lookup]);
        if (incompleteRuns.length > 0) {
          throwToolInputError(
            "Scheduled task cannot be moved while an occurrence is already running. Try again after the current run finishes.",
          );
        }
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
      const nextDestination = changingDestination
        ? activeDestination
        : lookup.destination;
      const next: ScheduledTask = {
        ...lookup,
        conversationAccess: changingDestination
          ? getConversationAccess(activeDestination, context.source)
          : lookup.conversationAccess,
        credentialMode,
        destination: nextDestination,
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

      // Destination already here with only destination:"here" is a no-op success.
      if (
        !changingDestination &&
        !instructionChanged &&
        !compiled &&
        status === undefined &&
        (input.credential_mode === undefined ||
          input.credential_mode === null ||
          input.credential_mode === lookup.credentialMode) &&
        moveHere
      ) {
        return scheduleTaskToolResult(
          "slackScheduleUpdateTask",
          compactTask(lookup),
        );
      }

      await store.saveTask(next);
      const committed = await store.getTask(input.task_id);
      if (!committed) {
        throwToolInputError("Scheduled task update did not complete.");
      }
      if (changingDestination) {
        if (!sameDestination(committed, activeDestination)) {
          throwToolInputError("Scheduled task move did not complete.");
        }
        logInfo(
          "scheduled_task.move.completed",
          scheduledTaskAttributes(committed),
        );
      }
      return scheduleTaskToolResult(
        "slackScheduleUpdateTask",
        compactTask(committed),
      );
    },
  });
}
