import { messageCardRefSchema } from "@/chat/conversations/cards";
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

/** Create a tool that removes a scheduled automation from the active Slack conversation. */
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
      "Delete one scheduled Junior task from the active Slack conversation. Use only task IDs returned for this conversation. Do not delete schedules from threads, other channels, or another user's DM.",
    executionMode: "sequential",
    inputSchema: z.object({
      automationId: z
        .string()
        .min(1)
        .describe(
          "ID of the task to delete. Must be from this active Slack conversation.",
        ),
    }),
    outputSchema: scheduleAutomationToolResultSchema.extend({
      removedCards: z.array(messageCardRefSchema),
    }),
    execute: async ({ automationId }) => {
      const lookup = await getWritableTask({ context, taskId: automationId });

      const next: ScheduledAutomation = {
        ...lookup,
        updatedAtMs: Date.now(),
        status: "deleted",
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
      };

      await saveScheduledAutomation(getDb(), next);
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
