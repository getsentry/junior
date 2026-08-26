import { z } from "zod";
import { listResourceEventSubscriptions } from "@/chat/resource-events/store";
import {
  RESOURCE_WATCH_TOOL_SOURCE,
  requireResourceWatchThread,
} from "@/chat/resource-events/tool-support";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const listedResourceWatchSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    identifier: z.string().min(1),
    namespace: z.string().min(1),
    resourceType: z.string().min(1),
    events: z.array(z.string().min(1)).min(1),
    match: z.record(z.string(), z.unknown()).optional(),
    intent: z.string().min(1),
    expiresAtMs: z.number().finite(),
  })
  .strict();

const resultDataSchema = z
  .object({ subscriptions: z.array(listedResourceWatchSchema) })
  .strict();

const outputSchema = juniorToolOutputSchema.merge(resultDataSchema);

/** Create the tool that lists active resource watches for this conversation. */
export function createListResourceEventSubscriptionsTool(
  context: ToolRuntimeContext,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "List active resource event subscriptions for the current conversation.",
    exposure: "deferred",
    source: RESOURCE_WATCH_TOOL_SOURCE,
    inputSchema: z.object({}).strict(),
    outputSchema,
    async execute() {
      const thread = requireResourceWatchThread({
        conversationId: context.conversationId,
        destination: context.destination,
        source: context.source,
      });
      const subscriptions = await listResourceEventSubscriptions({
        conversationId: thread.conversationId,
      });
      const details = {
        subscriptions: subscriptions.map((subscription) => ({
          id: subscription.id,
          label: subscription.label,
          identifier: subscription.identifier,
          namespace: subscription.namespace,
          resourceType: subscription.resourceType,
          events: subscription.events,
          ...(subscription.match ? { match: subscription.match } : undefined),
          intent: subscription.intent,
          expiresAtMs: subscription.expiresAtMs,
        })),
      };
      return {
        ...details,
      };
    },
  });
}
