import {
  automationToolContext,
  automationToolsDisabledReason,
} from "@/chat/automations/tool-access";
import { createScheduledAutomationTool } from "@/chat/scheduled-automations/tools/create";
import { createDeleteScheduledAutomationTool } from "@/chat/scheduled-automations/tools/delete";
import { createRunScheduledAutomationNowTool } from "@/chat/scheduled-automations/tools/run-now";
import { createSearchScheduledAutomationsTool } from "@/chat/scheduled-automations/tools/search";
import { createUpdateScheduledAutomationTool } from "@/chat/scheduled-automations/tools/update";
import { disableTools, type ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Build scheduled-automation tools. A Turn that no person started cannot use them. */
export function createScheduledAutomationTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  const taskContext = automationToolContext(context);
  return disableTools(
    {
      createScheduledAutomation: createScheduledAutomationTool(taskContext),
      searchScheduledAutomations:
        createSearchScheduledAutomationsTool(taskContext),
      updateScheduledAutomation:
        createUpdateScheduledAutomationTool(taskContext),
      deleteScheduledAutomation:
        createDeleteScheduledAutomationTool(taskContext),
      runScheduledAutomationNow:
        createRunScheduledAutomationNowTool(taskContext),
    },
    automationToolsDisabledReason(context),
  );
}
