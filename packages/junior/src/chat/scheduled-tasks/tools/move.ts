import { logInfo } from "@/chat/logging";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import { scheduledTaskAttributes } from "../telemetry";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  getConversationAccess,
  requireActiveConversation,
  requireActor,
  sameDestination,
  scheduleTaskToolResult,
  scheduleTaskToolResultSchema,
  schedulerStore,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that moves a creator-owned scheduled task into the active conversation. */
export function createSlackScheduleMoveTaskTool(
  context: SchedulerToolContext,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Move one of the requester's scheduled Junior tasks into the active Slack conversation. Destination is always the current conversation; do not pass a destination. Prefer this over create+delete when the user asks to move a task here from another channel.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        task_id: z
          .string()
          .min(1)
          .describe(
            "ID of the scheduled task to move. Use an ID returned by slackScheduleFindTasks or another scheduler tool for this requester.",
          ),
      })
      .strict(),
    outputSchema: scheduleTaskToolResultSchema,
    execute: async ({ task_id }) => {
      const destination = requireActiveConversation(context);
      const actor = requireActor(context, destination);
      const store = schedulerStore(context);
      const task = await store.getTask(task_id);

      if (!task || task.status === "deleted") {
        throwToolInputError("Scheduled task was not found.");
      }
      if (task.status === "completed") {
        throwToolInputError(
          "Completed scheduled tasks cannot be moved. Create a new task instead.",
        );
      }
      if (task.destination.platform !== "slack") {
        throwToolInputError("Scheduled task destination is invalid.");
      }
      if (task.destination.teamId !== destination.teamId) {
        throwToolInputError(
          "Scheduled tasks can only be moved within the same Slack workspace.",
        );
      }
      if (task.createdBy.slackUserId !== actor.slackUserId) {
        throwToolInputError(
          "Only the scheduled task creator can move this task.",
        );
      }
      if (sameDestination(task, destination)) {
        return scheduleTaskToolResult(
          "slackScheduleMoveTask",
          compactTask(task),
        );
      }

      const incompleteRuns = await store.listIncompleteRunsForTasks([task]);
      if (incompleteRuns.length > 0) {
        throwToolInputError(
          "Scheduled task cannot be moved while an occurrence is already running. Try again after the current run finishes.",
        );
      }

      const next: ScheduledTask = {
        ...task,
        conversationAccess: getConversationAccess(destination, context.source),
        destination,
        updatedAtMs: context.now?.() ?? Date.now(),
      };

      await store.saveTask(next);
      const committed = await store.getTask(task_id);
      if (!committed || !sameDestination(committed, destination)) {
        throwToolInputError("Scheduled task move did not complete.");
      }
      logInfo("scheduled_task.move.completed", scheduledTaskAttributes(committed));
      return scheduleTaskToolResult(
        "slackScheduleMoveTask",
        compactTask(committed),
      );
    },
  });
}
