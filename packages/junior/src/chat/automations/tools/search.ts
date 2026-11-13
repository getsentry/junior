import {
  automationSearchInputSchema,
  requireToolCaller,
  searchToolAutomations,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  automationSearchResultSchema,
  compactAutomation,
} from "@/chat/automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { AUTOMATIONS_TOOL_SOURCE } from "@/chat/automations/tool-source";

/**
 * Create the tool that searches scheduled and event Automations with the
 * dashboard Automations search. It also finds the Automations that deliver
 * to this Conversation.
 */
export function createSearchAutomationsTool(
  context: AutomationToolContext,
  catalog: EventCatalog,
) {
  return zodTool({
    exposure: "deferred",
    source: AUTOMATIONS_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "Search scheduled and event automations. It finds the requester's automations, automations in public channels, and automations that deliver to this conversation. Each result says whether the requester is the creator (is_creator); only the creator can change its credential use. For an event automation, warn when trigger.available is false and explain trigger.problems: the automation stays stored, but a plugin no longer supports its resource type, an event, or a filter. Update the trigger to fix it.",
    inputSchema: automationSearchInputSchema,
    outputSchema: automationSearchResultSchema,
    async execute(input) {
      const { automations, truncated } = await searchToolAutomations(
        context,
        await requireToolCaller(context),
        input,
      );
      return {
        automations: automations.map((candidate) =>
          compactAutomation(candidate, catalog),
        ),
        truncated,
      };
    },
  });
}
