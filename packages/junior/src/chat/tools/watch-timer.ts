import { z } from "zod";
import { createTimerWatch } from "@/chat/events/store";
import { RESOURCE_SUBSCRIPTION_MAX_TTL_MS } from "@/chat/events/tool-support";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Create one heartbeat-backed Watch in the current Conversation. */
export function createWatchTimerTool(context: ToolRuntimeContext) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Wake this conversation once after a delay so you can check back later. Returns immediately. Timing is approximate. Use watchEvents instead when you can watch for the event.",
    inputSchema: z
      .object({
        afterMs: z
          .number()
          .int()
          .positive()
          .max(RESOURCE_SUBSCRIPTION_MAX_TTL_MS - 24 * 60 * 60 * 1000)
          .describe("Delay in milliseconds, up to 29 days."),
        intent: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .describe("What to do when the timer fires."),
      })
      .strict(),
    outputSchema: z.object({ id: z.string(), firesAtMs: z.number() }).strict(),
    async execute(input, options) {
      if (!options.toolCallId)
        throw new Error("Timer creation requires a tool-call identity");
      const watch = await createTimerWatch({
        ...input,
        conversationId: context.conversationId,
        toolCallId: options.toolCallId,
      });
      return { id: watch.id, firesAtMs: watch.firesAtMs! };
    },
  });
}
