import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stopConversationTurnForViewer } from "@/api/conversations/stop";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
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
          .describe("`no_work` when nothing was running."),
        droppedMessages: z.number().int(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ conversationId }) => {
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
