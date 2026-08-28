import {
  hasPluginResourceEventCatalogEntries,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { createEventTaskTool } from "@/chat/tools/create-event-task";
import { createDeleteEventTaskTool } from "@/chat/tools/delete-event-task";
import type { ToolRegistry } from "@/chat/tools/definition";
import { createListEventTasksTool } from "@/chat/tools/list-event-tasks";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createUpdateEventTaskTool } from "@/chat/tools/update-event-task";

/** Build event task tools for an interactive Slack actor. */
export function createEventTaskTools(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
): ToolRegistry {
  if (
    context.source.platform !== "slack" ||
    context.destination.platform !== "slack" ||
    context.actor?.platform !== "slack"
  ) {
    return {};
  }
  // Durable event tasks need a plugin publisher. Core snapshot events alone
  // only support temporary watches from switchWorkspace / watchResourceEvents.
  const canCreate = hasPluginResourceEventCatalogEntries(catalog);
  return {
    ...(canCreate
      ? { createEventTask: createEventTaskTool(context, catalog) }
      : undefined),
    listEventTasks: createListEventTasksTool(context, catalog),
    updateEventTask: createUpdateEventTaskTool(context, catalog),
    deleteEventTask: createDeleteEventTaskTool(context, catalog),
  };
}
