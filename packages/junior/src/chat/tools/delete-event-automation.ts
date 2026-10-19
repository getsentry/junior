import { removedCardSchema } from "@/chat/conversations/cards";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { deleteEventAutomation } from "@/chat/event-automations/store";
import {
  compactEventAutomation,
  eventAutomationToolResultSchema,
  writableEventAutomation,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { isRequesterAutomationCreator } from "@/chat/automations/creator";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
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
    description: "Delete an event automation.",
    inputSchema: z.object({ automationId: z.string().min(1) }).strict(),
    outputSchema: eventAutomationToolResultSchema
      .omit({ objectCards: true })
      .extend({ removedCards: z.array(removedCardSchema) }),
    async execute({ automationId }) {
      const current = await writableEventAutomation(context, automationId);
      const deleted = await deleteEventAutomation(getDb(), current.id);
      if (!deleted) {
        throw new ToolInputError("Event automation was not found.");
      }
      await createPluginAnnotations({
        conversationId: context.conversationId,
        db: getDb(),
        plugin: "junior",
      }).remove("object", automationId);
      return {
        automation: compactEventAutomation(
          deleted,
          catalog,
          isRequesterAutomationCreator(
            await context.resolveActorIdentity?.(),
            current,
          ),
        ),
        removedCards: [{ plugin: "junior", key: automationId }],
      };
    },
  });
}
