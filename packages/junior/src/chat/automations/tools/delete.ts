import * as z from "zod";
import { removedCardSchema } from "@/chat/conversations/cards";
import {
  deleteToolAutomation,
  requireToolAutomation,
  requireToolCaller,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  automationToolResultSchema,
  compactAutomation,
} from "@/chat/automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { AUTOMATIONS_TOOL_SOURCE } from "@/chat/automations/tool-source";

export const deleteAutomationToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: AUTOMATIONS_TOOL_SOURCE,
  approvalMode: "review",
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  executionMode: "sequential",
  description:
    "Delete one scheduled or event automation. Anyone in the workspace can delete an automation in a public channel. Automations in private channels and DMs can be deleted from there or by their creator.",
  inputSchema: z
    .object({
      automation_id: z
        .string()
        .min(1)
        .describe(
          "ID of the automation to delete, from searchAutomations or its dashboard URL.",
        ),
    })
    .strict(),
  outputSchema: automationToolResultSchema
    .omit({ objectCards: true })
    .extend({ removedCards: z.array(removedCardSchema) }),
});

/** Create the tool that deletes one Automation. */
export function createDeleteAutomationTool(
  context: AutomationToolContext,
  catalog: EventCatalog,
) {
  return zodTool({
    ...deleteAutomationToolDefinition,
    async execute({ automation_id: automationId }) {
      const current = await requireToolAutomation(
        await requireToolCaller(context),
        automationId,
      );
      const deleted = await deleteToolAutomation(
        context.conversationId,
        current,
      );
      return {
        automation: compactAutomation(deleted, catalog),
        removedCards: [{ plugin: "junior", key: automationId }],
      };
    },
  });
}
