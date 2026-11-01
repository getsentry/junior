import { automationToolsDisabledReason } from "@/chat/automations/tool-access";
import type { EventCatalog } from "@/chat/events/catalog";
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import { createDeleteEventAutomationTool } from "@/chat/tools/delete-event-automation";
import { disableTools, type ToolRegistry } from "@/chat/tools/definition";
import { createSearchEventAutomationsTool } from "@/chat/tools/search-event-automations";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";

/** Build event automation tools. A Turn that no person started cannot use them. */
export function createEventAutomationTools(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
): ToolRegistry {
  return disableTools(
    {
      createEventAutomation: createEventAutomationTool(context, catalog),
      searchEventAutomations: createSearchEventAutomationsTool(
        context,
        catalog,
      ),
      updateEventAutomation: createUpdateEventAutomationTool(context, catalog),
      deleteEventAutomation: createDeleteEventAutomationTool(context, catalog),
    },
    automationToolsDisabledReason(context),
  );
}
