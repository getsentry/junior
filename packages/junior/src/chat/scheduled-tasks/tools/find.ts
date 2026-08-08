import {
  parseRequiredSlackChannelIdParam,
  slackChannelIdParam,
} from "@/chat/slack/id-param";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import type { ScheduledTask } from "../types";
import {
  compactTask,
  MAX_LISTED_TASKS,
  requireActiveConversation,
  requireActor,
  scheduleListToolResult,
  scheduleListToolResultSchema,
  schedulerStore,
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

/** Create a tool that finds the requester's scheduled tasks across the workspace. */
export function createSlackScheduleFindTasksTool(
  context: SchedulerToolContext,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "Find scheduled Junior tasks created by the current requester across the active Slack workspace. Use when the user wants to move or identify one of their tasks from another channel without listing that source channel. Optional channel_id and query narrow the match; do not invent channel IDs.",
    inputSchema: z
      .object({
        channel_id: slackChannelIdParam(
          "Optional source Slack channel/conversation ID to search within (for example C123). Prefer a channel mention from the user request.",
        )
          .nullable()
          .optional(),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullable()
          .describe(
            "Optional natural-language filter matched against task title, instruction, schedule, timezone, or status.",
          )
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
      const matching = (
        await schedulerStore(context).listTasksForTeam(destination.teamId)
      )
        .filter(
          (task) =>
            task.destination.platform === "slack" &&
            task.destination.teamId === destination.teamId &&
            task.createdBy.slackUserId === actor.slackUserId &&
            task.status !== "completed" &&
            (!channelId || task.destination.channelId === channelId) &&
            (!query || taskMatchesQuery(task, query)),
        )
        .sort(
          (left, right) =>
            right.createdAtMs - left.createdAtMs ||
            right.id.localeCompare(left.id),
        );
      const visible = matching.slice(0, MAX_LISTED_TASKS).map(compactTask);

      return scheduleListToolResult({
        target: "slackScheduleFindTasks",
        tasks: visible,
        truncated: matching.length > visible.length,
      });
    },
  });
}
