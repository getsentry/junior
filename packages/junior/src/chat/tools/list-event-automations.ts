import { z } from "zod";
import { getDb } from "@/chat/db";
import { listEventAutomationsForTeam } from "@/chat/event-automations/store";
import {
  compactEventAutomation,
  eventAutomationListToolResultSchema,
  eventAutomationMatchesDestination,
  requireEventAutomationSlackContext,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const MAX_LISTED_EVENT_AUTOMATIONS = 50;

/** Create the core tool that lists event automations for this destination. */
export function createListEventAutomationsTool(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "List event automations for the current destination, not one thread. Each result says whether the requester is the creator (isCreator); only the creator can change its credential use. Warn when trigger.available is false: the automation stays stored but cannot receive events until its plugin event is enabled again. Public automations can also be updated or deleted by id from another destination in the same workspace.",
    inputSchema: z.object({}).strict(),
    outputSchema: eventAutomationListToolResultSchema,
    async execute() {
      const { actor, destination } =
        requireEventAutomationSlackContext(context);
      const matching = (
        await listEventAutomationsForTeam(getDb(), destination.teamId)
      ).filter((task) => eventAutomationMatchesDestination(task, destination));
      const automations = matching
        .slice(0, MAX_LISTED_EVENT_AUTOMATIONS)
        .map((task) => compactEventAutomation(task, catalog, actor.userId));
      return {
        automations,
        truncated: matching.length > automations.length,
      };
    },
  });
}
