import type { EventCatalog } from "@/chat/events/catalog";
import { getSlackToolContext } from "@/chat/slack/tool-support/context";
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import { createDeleteEventAutomationTool } from "@/chat/tools/delete-event-automation";
import type { ToolRegistry } from "@/chat/tools/definition";
import { createListEventAutomationsTool } from "@/chat/tools/list-event-automations";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";

/**
 * Build event automation tools for a Conversation with a Slack Location.
 *
 * Registration depends only on the Location, so every Turn in the
 * Conversation sends the same tool list and keeps the prompt cache. Each tool
 * checks at execution that a person's Slack message started the Turn.
 */
export function createEventAutomationTools(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
): ToolRegistry {
  // TODO(dcramer): Let users manage Event automations from web and other
  // Conversations. Remove this check when Event automations no longer require a
  // Slack Destination or Slack creator.
  if (!getSlackToolContext(context)) {
    return {};
  }
  return {
    createEventAutomation: createEventAutomationTool(context, catalog),
    listEventAutomations: createListEventAutomationsTool(context, catalog),
    updateEventAutomation: createUpdateEventAutomationTool(context, catalog),
    deleteEventAutomation: createDeleteEventAutomationTool(context, catalog),
  };
}
