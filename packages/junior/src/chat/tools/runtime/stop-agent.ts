import { z } from "zod";
import { stopChildAgent } from "@/chat/agent-invocations/stop";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const stopAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Stopped child conversation ID"),
  stopped: z
    .boolean()
    .describe(
      "True when work was stopped. False when the child agent had already stopped.",
    ),
});

/** Create the tool that stops one child agent of one conversation. */
export function createStopAgentTool(conversationId: string) {
  return zodTool({
    description:
      "Stop a child agent that this conversation started, and every child agent it started. Use it when the child agent's work is no longer needed or goes in the wrong direction. A stopped child agent sends no result. To give a named child agent new work later, call spawnAgent with its name.",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z
      .object({
        conversation_id: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Child conversation ID from spawnAgent or listAgents to stop",
          ),
      })
      .strict(),
    outputSchema: stopAgentOutputSchema,
    execute: async (input) => {
      const stopped = await stopChildAgent({
        childConversationId: input.conversation_id,
        parentConversationId: conversationId,
      });
      if (!stopped) {
        throw new ToolInputError(
          `${input.conversation_id} is not a child agent of this conversation. Use listAgents to find its conversation_id.`,
        );
      }
      return {
        conversation_id: input.conversation_id,
        stopped: stopped.stoppedCount > 0,
      };
    },
  });
}
