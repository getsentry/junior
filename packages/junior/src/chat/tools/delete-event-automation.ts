import { z } from "zod";
import { getDb } from "@/chat/db";
import { deleteEventAutomation } from "@/chat/event-automations/store";
import {
  eventAutomationToolResult,
  eventAutomationToolResultSchema,
  writableEventAutomation,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
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
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    outputSchema: eventAutomationToolResultSchema,
    async execute({ taskId }) {
      const current = await writableEventAutomation(context, taskId);
      const deleted = await deleteEventAutomation(getDb(), current.id);
      if (!deleted) {
        throw new ToolInputError("Event automation was not found.");
      }
      return eventAutomationToolResult(deleted, catalog);
    },
  });
}
