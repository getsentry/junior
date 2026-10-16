import { z } from "zod";
import { findOwnedWatch, listOwnedWatches } from "@/chat/events/owned-watches";
import { cancelWatch } from "@/chat/events/store";
import { RESOURCE_WATCH_TOOL_SOURCE } from "@/chat/events/tool-support";
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

/**
 * Create the tool that stops watches this conversation owns. The conversation
 * owns its own watches and those of every child agent below it, so a stop of
 * every watch also stops the watches of those child agents. A child agent
 * cannot stop a watch of its parent or of a sibling.
 */
export function createStopWatchingResourcesTool(context: ToolRuntimeContext) {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Stop one watch by id. The watch can belong to the current conversation or to a child agent below it. Omit id only when the user explicitly asks to stop every watch in this conversation; that also stops every watch of its child agents. Infer terse stop requests from context, inspect active watches when the target is unclear, and call this tool before confirming that watching stopped.",
    exposure: "deferred",
    source: RESOURCE_WATCH_TOOL_SOURCE,
    inputSchema: z
      .object({ id: z.string().min(1).nullable().optional() })
      .strict(),
    outputSchema,
    async execute({ id }) {
      let stoppedIds: string[];
      if (id) {
        const owned = await findOwnedWatch({
          conversationId: context.conversationId,
          id,
        });
        const stopped = owned
          ? await cancelWatch({ conversationId: owned.conversationId, id })
          : undefined;
        if (!stopped) {
          throw new ToolInputError(
            "Watch was not found in the current conversation or its child agents.",
          );
        }
        if (stopped.status === "completed") {
          throw new ToolInputError(
            "Watch already completed; delivered input cannot be recalled.",
          );
        }
        stoppedIds = [stopped.id];
      } else {
        stoppedIds = [];
        for (const { watch } of await listOwnedWatches(
          context.conversationId,
        )) {
          const stopped = await cancelWatch({
            conversationId: watch.conversationId,
            id: watch.id,
          });
          if (stopped?.status === "cancelled") {
            stoppedIds.push(stopped.id);
          }
        }
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
