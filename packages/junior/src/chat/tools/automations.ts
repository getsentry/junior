import {
  automationToolContext,
  automationToolsDisabledReason,
} from "@/chat/automations/tool-access";
import { createAutomationTool } from "@/chat/automations/tools/create";
import { createDeleteAutomationTool } from "@/chat/automations/tools/delete";
import { createRunAutomationNowTool } from "@/chat/automations/tools/run-now";
import { createSearchAutomationsTool } from "@/chat/automations/tools/search";
import { createUpdateAutomationTool } from "@/chat/automations/tools/update";
import type { EventCatalog } from "@/chat/events/catalog";
import { disableTools, type ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Build the Automation tools. A Turn that no person started cannot use them. */
export function createAutomationTools(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
): ToolRegistry {
  const automationContext = automationToolContext(context);
  return disableTools(
    {
      createAutomation: createAutomationTool(automationContext, catalog),
      searchAutomations: createSearchAutomationsTool(
        automationContext,
        catalog,
      ),
      updateAutomation: createUpdateAutomationTool(automationContext, catalog),
      deleteAutomation: createDeleteAutomationTool(automationContext, catalog),
      runAutomationNow: createRunAutomationNowTool(automationContext, catalog),
    },
    automationToolsDisabledReason(context),
  );
}
