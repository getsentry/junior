import {
  hasPluginEventCatalogEntries,
  type EventCatalog,
} from "@/chat/events/catalog";
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import { createDeleteEventAutomationTool } from "@/chat/tools/delete-event-automation";
import type { ToolRegistry } from "@/chat/tools/definition";
import { createListEventAutomationsTool } from "@/chat/tools/list-event-automations";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";

/** Build event automation tools for an interactive Slack actor. */
export function createEventAutomationTools(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
): ToolRegistry {
  // TODO(dcramer): Let users manage Event automations from web and other
  // Conversations. Remove these checks when Event automations no longer require a
  // Slack Destination or Slack creator.
  if (
    context.source.kind !== "slack" ||
    context.destination.platform !== "slack" ||
    context.actor?.platform !== "slack"
  ) {
    return {};
  }
  // Durable event automations need a plugin publisher. Core snapshot events alone
  // only support temporary watches from switchWorkspace / watchEvents.
  const canCreate = hasPluginEventCatalogEntries(catalog);
  return {
    ...(canCreate
      ? { createEventAutomation: createEventAutomationTool(context, catalog) }
      : undefined),
    listEventAutomations: createListEventAutomationsTool(context, catalog),
    updateEventAutomation: createUpdateEventAutomationTool(context, catalog),
    deleteEventAutomation: createDeleteEventAutomationTool(context, catalog),
  };
}
