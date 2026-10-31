import { automationRevision } from "@/chat/automations/revision";
import { removedCardSchema } from "@/chat/conversations/cards";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveScheduledAutomation } from "../tasks";
import type { ScheduledAutomation } from "../types";
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
      "Delete one scheduled automation. Anyone in the Slack channel where it delivers can delete it. From another channel in the same workspace, only its creator can delete it.",
    executionMode: "sequential",
    inputSchema: z.object({
      automationId: z
        .string()
        .min(1)
        .describe(
          "ID of the scheduled automation to delete, from slackScheduleListAutomations or its dashboard URL.",
        ),
    }),
    outputSchema: scheduleAutomationToolResultSchema.extend({
      removedCards: z.array(removedCardSchema),
    }),
    execute: async ({ automationId }) => {
      const lookup = await getWritableTask({
        action: "lifecycle",
        context,
        taskId: automationId,
      });

      const next: ScheduledAutomation = {
        ...lookup,
        updatedAtMs: Date.now(),
        status: "deleted",
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
      };

      await saveScheduledAutomation(getDb(), next, automationRevision(lookup));
      await createPluginAnnotations({
        conversationId: context.conversationId,
        db: getDb(),
        plugin: "junior",
      }).remove("object", automationId);
      return {
        automation: compactTask(next, context.actor?.userId),
        removedCards: [{ plugin: "junior", key: automationId }],
      };
    },
  });
}
