import { removedCardSchema } from "@/chat/conversations/cards";
import {
  deleteToolAutomation,
  requireToolAutomation,
  slackToolViewer,
} from "@/chat/automations/tool-access";
import { z } from "zod";
import {
  compactEventAutomation,
  eventAutomationToolResultSchema,
  requireEventAutomationSlackContext,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Create the core tool that deletes an event automation. */
export function createDeleteEventAutomationTool(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Delete an event automation. Anyone in the workspace can delete an automation in a public channel. Automations in private channels and DMs can be deleted from there or by their creator.",
    inputSchema: z.object({ automationId: z.string().min(1) }).strict(),
    outputSchema: eventAutomationToolResultSchema
      .omit({ objectCards: true })
      .extend({ removedCards: z.array(removedCardSchema) }),
    async execute({ automationId }) {
      const { actor, destination } =
        requireEventAutomationSlackContext(context);
      const current = await requireToolAutomation(
        slackToolViewer(await context.resolveActorIdentity?.(), destination),
        "event",
        automationId,
      );
      const deleted = await deleteToolAutomation(
        context.conversationId,
        current,
      );
      return {
        automation: compactEventAutomation(deleted, catalog, actor.userId),
        removedCards: [{ plugin: "junior", key: automationId }],
      };
    },
  });
}
