import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { stopConversationTurnForViewer } from "@/api/conversations/stop";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/** Register `stopConversation`, which stops the active Turn. */
export function registerStopConversationTool(
  server: McpServer,
  { queue, user }: McpToolContext,
): void {
  server.registerTool(
    "stopConversation",
    {
      title: "Stop conversation",
      description:
        "Stop the running turn of one of your conversations. Messages that wait for the turn are dropped. It starts no new work.",
      inputSchema: { conversationId: mcpConversationIdSchema },
      outputSchema: {
        status: z
          .enum(["no_work", "requested"])
          .describe(
            "`requested` when the running turn was asked to stop. `no_work` when nothing was running.",
          ),
        droppedMessages: z
          .number()
          .int()
          .describe("Messages that waited for the turn and were dropped."),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ conversationId }) => {
      if (!(await isConversationParticipant(user, conversationId))) {
        return mcpToolError("Conversation not found.");
      }
      try {
        const result = await stopConversationTurnForViewer(
          user,
          conversationId,
          { queue },
        );
        return mcpToolResult({
          status: result.status,
          droppedMessages: result.stoppedInboundMessageIds.length,
        });
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
