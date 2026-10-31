import { automationListQuerySchema } from "@/api/schema/automation";
import { readAutomationCollection } from "@/chat/automations/collection";
import { slackToolViewer } from "@/chat/automations/tool-access";
import {
  parseRequiredSlackChannelIdParam,
  slackChannelIdParam,
} from "@/chat/slack/id-param";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { readScheduledAutomations } from "../tasks";
import {
  compactTask,
  MAX_LISTED_TASKS,
  requireActiveChannel,
  requireActor,
  scheduleListToolResult,
  scheduleListToolResultSchema,
  throwToolInputError,
  type SchedulerToolContext,
} from "../tool-support";

/**
 * Create a tool that searches scheduled automations with the dashboard
 * Automations search. It finds the same automations as the dashboard, and
 * also the automations that deliver to the active channel.
 */
export function createSlackScheduleSearchAutomationsTool(
  context: SchedulerToolContext,
) {
  return zodTool({
    description:
      'Search scheduled automations in this Slack workspace. It finds the requester\'s automations, automations in public channels, and automations in the active conversation. Use scope "here" for the active conversation and "mine" for the requester\'s own. Each result says whether the requester is the creator.',
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullable()
          .describe(
            "Text in the title or instruction, an automation ID, or a dashboard URL.",
          )
          .optional(),
        scope: z
          .enum(["all", "here", "mine"])
          .nullable()
          .describe(
            "all: everything the requester can find. here: only the active conversation. mine: only automations the requester created. Defaults to all.",
          )
          .optional(),
        channel_id: slackChannelIdParam(
          "Limit results to the automations that deliver to this channel. Use the ID from a channel mention; do not guess.",
        )
          .nullable()
          .optional(),
      })
      .strict(),
    outputSchema: scheduleListToolResultSchema,
    execute: async (input) => {
      const channel = requireActiveChannel(context);
      const actor = requireActor(context, channel);

      let channelId: string | undefined;
      if (input.channel_id != null) {
        const parsed = parseRequiredSlackChannelIdParam(
          "channel_id",
          input.channel_id,
        );
        if (!parsed.ok) throwToolInputError(parsed.error);
        channelId = parsed.value;
      }
      if (input.scope === "here") {
        if (channelId && channelId !== channel.channelId) {
          throwToolInputError('Use scope "here" or channel_id, not both.');
        }
        channelId = channel.channelId;
      }

      const viewer = slackToolViewer(
        await context.users.resolveActor(),
        channel,
        actor.slackUserId,
      );
      const { rows, total } = await readAutomationCollection(
        viewer,
        automationListQuerySchema.parse({
          q: input.query ?? undefined,
          scope: input.scope === "mine" ? "mine" : "all",
          type: "scheduled",
          destination: channelId ? `${channel.teamId}:${channelId}` : undefined,
          pageSize: MAX_LISTED_TASKS,
        }),
      );
      const tasks = await readScheduledAutomations(
        getDb(),
        rows.map((row) => row.id),
      );
      return scheduleListToolResult({
        automations: tasks.map((task) => compactTask(task, actor.slackUserId)),
        truncated: total > rows.length,
      });
    },
  });
}
