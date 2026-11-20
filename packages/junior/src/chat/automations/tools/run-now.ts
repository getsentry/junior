import * as z from "zod";
import { runAutomationNow } from "@/chat/automations/edit";
import {
  requireToolAutomation,
  requireToolCaller,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  automationToolResultSchema,
  compactAutomation,
} from "@/chat/automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { AUTOMATIONS_TOOL_SOURCE } from "@/chat/automations/tool-source";

export const runAutomationNowToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: AUTOMATIONS_TOOL_SOURCE,
  approvalMode: "review",
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  executionMode: "sequential",
  description:
    "Queue an existing active scheduled automation to run as soon as possible, without changing its schedule. Use when the user asks to run it now. Anyone who can manage the automation can run it. When it uses its creator's credentials, only the creator can run it now. Event automations run only when a matching event arrives, so they cannot run now.",
  inputSchema: z
    .object({
      automation_id: z
        .string()
        .min(1)
        .describe(
          "ID of the active scheduled automation to run now, from searchAutomations or its dashboard URL.",
        ),
    })
    .strict(),
  outputSchema: automationToolResultSchema.omit({ objectCards: true }),
});

/** Create the tool that marks an active scheduled Automation due now. */
export function createRunAutomationNowTool(
  context: AutomationToolContext,
  catalog: EventCatalog,
) {
  return zodTool({
    ...runAutomationNowToolDefinition,
    async execute({ automation_id: automationId }) {
      const current = await requireToolAutomation(
        await requireToolCaller(context),
        automationId,
      );
      const next = await runAutomationNow(current);
      return {
        automation: compactAutomation(next, catalog),
      };
    },
  });
}
