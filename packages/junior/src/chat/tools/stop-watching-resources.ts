import { z } from "zod";
import {
  cancelResourceEventSubscription,
  cancelSubscriptions,
  listResourceEventSubscriptions,
} from "@/chat/resource-events/store";
import {
  RESOURCE_WATCH_TOOL_SOURCE,
  requireResourceWatchThread,
} from "@/chat/resource-events/tool-support";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const resultDataSchema = z
  .object({
    watching_status: z.literal("stopped"),
    stoppedIds: z.array(z.string().min(1)),
  })
  .strict();

const outputSchema = juniorToolOutputSchema.merge(resultDataSchema);

/** Create the tool that stops resource watches for this conversation. */
export function createStopWatchingResourcesTool(context: ToolRuntimeContext) {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Stop one resource watch in the current Slack thread by id. Omit id only when the user explicitly asks to stop every watch in this thread. Infer terse stop requests from context, inspect active watches when the target is unclear, and call this tool before confirming that watching stopped.",
    exposure: "deferred",
    source: RESOURCE_WATCH_TOOL_SOURCE,
    inputSchema: z
      .object({ id: z.string().min(1).nullable().optional() })
      .strict(),
    outputSchema,
    async execute({ id }) {
      const thread = requireResourceWatchThread({
        conversationId: context.conversationId,
        destination: context.destination,
        source: context.source,
      });
      let stoppedIds: string[];
      if (id) {
        const stopped = await cancelResourceEventSubscription({
          conversationId: thread.conversationId,
          id,
        });
        if (!stopped) {
          throw new ToolInputError(
            "Resource watch was not found in the current Slack thread.",
          );
        }
        stoppedIds = [stopped.id];
      } else {
        const subscriptions = await listResourceEventSubscriptions({
          conversationId: thread.conversationId,
        });
        await cancelSubscriptions({ conversationId: thread.conversationId });
        stoppedIds = subscriptions.map((subscription) => subscription.id);
      }
      const details = {
        watching_status: "stopped" as const,
        stoppedIds,
      };
      return {
        ...details,
      };
    },
  });
}
