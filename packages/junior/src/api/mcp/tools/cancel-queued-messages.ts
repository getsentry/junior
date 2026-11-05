import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelConversationPendingMessagesForViewer } from "@/api/conversations/cancel-pending-messages";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register `cancelQueuedMessages`, which drops the messages that wait for
 * the running Turn and leaves the Turn running.
 */
export function registerCancelQueuedMessagesTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "cancelQueuedMessages",
    {
      title: "Cancel queued messages",
      description:
        "Drop every message that waits for the running turn of one of your conversations. The running turn continues.",
      inputSchema: { conversationId: mcpConversationIdSchema },
      outputSchema: {
        cancelledMessages: z.number().int().describe("Messages dropped."),
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
        const result = await cancelConversationPendingMessagesForViewer(
          user,
          conversationId,
        );
        return mcpToolResult({ cancelledMessages: result.cancelledCount });
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
