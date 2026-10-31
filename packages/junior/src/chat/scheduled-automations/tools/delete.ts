import { removedCardSchema } from "@/chat/conversations/cards";
import { deleteToolAutomation } from "@/chat/automations/tool-access";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import {
  getWritableTask,
  compactTask,
  scheduleAutomationToolResultSchema,
  type SchedulerToolContext,
} from "../tool-support";

/** Create a tool that deletes a scheduled automation. */
export function createSlackScheduleDeleteAutomationTool(
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
      "Delete one scheduled automation. Anyone in the workspace can delete an automation in a public channel. Automations in private channels and DMs can be deleted from there or by their creator.",
    executionMode: "sequential",
    inputSchema: z.object({
      automationId: z
        .string()
        .min(1)
        .describe(
          "ID of the scheduled automation to delete, from slackScheduleSearchAutomations or its dashboard URL.",
        ),
    }),
    outputSchema: scheduleAutomationToolResultSchema.extend({
      removedCards: z.array(removedCardSchema),
    }),
    execute: async ({ automationId }) => {
      const current = await getWritableTask(context, automationId);
      const deleted = await deleteToolAutomation(
        context.conversationId,
        current,
      );
      return {
        automation: compactTask(deleted, context.actor?.userId),
        removedCards: [{ plugin: "junior", key: automationId }],
      };
    },
  });
}
