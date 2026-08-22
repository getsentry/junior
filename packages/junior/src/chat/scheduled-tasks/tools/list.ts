import {
  parseRequiredSlackChannelIdParam,
  slackChannelIdParam,
} from "@/chat/slack/id-param";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { listScheduledTasksForTeam } from "../tasks";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  MAX_LISTED_TASKS,
  requireActiveConversation,
  requireActor,
  sameDestination,
  scheduleListToolResult,
  scheduleListToolResultSchema,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

function taskMatchesQuery(task: ScheduledTask, query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    task.title,
    task.task.text,
    task.schedule.description,
    task.schedule.timezone,
    task.status,
  ].some((value) => value?.toLowerCase().includes(normalized));
}

/** Create a tool that lists scheduled tasks for the active conversation or the requester. */
export function createSlackScheduleListTasksTool(
  context: SchedulerToolContext,
) {
  return zodTool({
    description:
      "List scheduled tasks in this Slack conversation. To find one of the requester's tasks elsewhere in the workspace, pass channel_id and/or query.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        channel_id: slackChannelIdParam(
          "Current destination channel ID to filter by. Use the ID from a channel mention; do not guess.",
        )
          .nullable()
          .optional(),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullable()
          .describe("Text to match in the requester's scheduled tasks.")
          .optional(),
      })
      .strict(),
    outputSchema: scheduleListToolResultSchema,
    execute: async (input) => {
      const destination = requireActiveConversation(context);
      const actor = requireActor(context, destination);

      let channelId: string | undefined;
      if (input.channel_id != null) {
        const parsed = parseRequiredSlackChannelIdParam(
          "channel_id",
          input.channel_id,
        );
        if (!parsed.ok) {
          throwToolInputError(parsed.error);
        }
        channelId = parsed.value;
      }
      const query = input.query?.trim() || undefined;
      const crossConversation =
        Boolean(query) ||
        (channelId !== undefined && channelId !== destination.channelId);

      const matching = (
        await listScheduledTasksForTeam(getDb(), destination.teamId)
      )
        .filter((task) => {
          if (task.destination.platform !== "slack") return false;
          if (task.destination.teamId !== destination.teamId) return false;
          if (task.status === "completed") return false;
          if (channelId && task.destination.channelId !== channelId) {
            return false;
          }
          if (!crossConversation && !sameDestination(task, destination)) {
            return false;
          }
          // Outside the active conversation, only the creator can discover tasks.
          if (
            crossConversation &&
            !sameDestination(task, destination) &&
            task.createdBy.slackUserId !== actor.slackUserId
          ) {
            return false;
          }
          if (query && !taskMatchesQuery(task, query)) return false;
          return true;
        })
        .sort(
          (left, right) =>
            right.createdAtMs - left.createdAtMs ||
            right.id.localeCompare(left.id),
        );
      const visible = matching.slice(0, MAX_LISTED_TASKS).map(compactTask);

      return scheduleListToolResult({
        target: "slackScheduleListTasks",
        tasks: visible,
        truncated: matching.length > visible.length,
      });
    },
  });
}
