import { z } from "zod";
import { listOwnedWatches } from "@/chat/events/owned-watches";
import { RESOURCE_WATCH_TOOL_SOURCE } from "@/chat/events/tool-support";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const listedResourceWatchSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    identifier: z.string().min(1),
    namespace: z.string().min(1),
    resource_type: z.string().min(1),
    events: z.array(z.string().min(1)).min(1),
    match: z.record(z.string(), z.unknown()).optional(),
    intent: z.string().min(1),
    expires_at: z.string().datetime(),
    fires_at: z.string().datetime().optional(),
    child_agent: z
      .object({
        conversation_id: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const resultDataSchema = z
  .object({ subscriptions: z.array(listedResourceWatchSchema) })
  .strict();

const outputSchema = juniorToolOutputSchema.merge(resultDataSchema);

/**
 * Create the tool that lists the active watches this conversation owns: its
 * own and those of every child agent below it.
 */
export function createListWatchesTool(context: ToolRuntimeContext) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "List active watches for the current conversation and for every child agent below it. A watch with child_agent belongs to that child agent; one without belongs to the current conversation.",
    exposure: "deferred",
    source: RESOURCE_WATCH_TOOL_SOURCE,
    inputSchema: z.object({}).strict(),
    outputSchema,
    async execute() {
      const owned = await listOwnedWatches(context.conversationId);
      const details = {
        subscriptions: owned.map(({ childAgent, watch: subscription }) => ({
          id: subscription.id,
          label: subscription.label,
          identifier: subscription.identifier,
          namespace: subscription.namespace,
          resource_type: subscription.resourceType,
          events: subscription.events,
          ...(subscription.match ? { match: subscription.match } : undefined),
          intent: subscription.intent,
          expires_at: new Date(subscription.expiresAtMs).toISOString(),
          ...(subscription.firesAtMs !== undefined
            ? { fires_at: new Date(subscription.firesAtMs).toISOString() }
            : undefined),
          ...(childAgent
            ? {
                child_agent: {
                  conversation_id: childAgent.conversationId,
                  ...(childAgent.name ? { name: childAgent.name } : undefined),
                },
              }
            : undefined),
        })),
      };
      return {
        ...details,
      };
    },
  });
}
