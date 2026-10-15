import type { EventCatalog } from "@/chat/events/catalog";
import {
  getSlackToolContext,
  slackMessageTurnDisabledReason,
} from "@/chat/slack/tool-support/context";
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import { createDeleteEventAutomationTool } from "@/chat/tools/delete-event-automation";
import { disableTools, type ToolRegistry } from "@/chat/tools/definition";
import { createListEventAutomationsTool } from "@/chat/tools/list-event-automations";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";

/**
 * Build event automation tools for a Conversation with a Slack Location.
 *
 * Registration depends only on the Location, so every Turn in the
 * Conversation sends the same tool list and keeps the prompt cache. Other
 * Turns get the tools disabled.
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
  return disableTools(
    {
      createEventAutomation: createEventAutomationTool(context, catalog),
      listEventAutomations: createListEventAutomationsTool(context, catalog),
      updateEventAutomation: createUpdateEventAutomationTool(context, catalog),
      deleteEventAutomation: createDeleteEventAutomationTool(context, catalog),
    },
    slackMessageTurnDisabledReason(context),
  );
}
