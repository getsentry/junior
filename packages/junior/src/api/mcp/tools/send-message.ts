import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendConversationMessageForViewer } from "@/api/conversations/create";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import {
  mcpAcceptedMessageSchema,
  mcpConversationIdSchema,
  mcpIdempotencyKeySchema,
  mcpMessageTextSchema,
} from "../conversation";
import {
  apiToolError,
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register `sendMessage`, which adds the user's message to a Conversation.
 * Junior reads it in a new Turn, or after the running Turn.
 */
export function registerSendMessageTool(
  server: McpServer,
  { attachmentStorage, queue, user }: McpToolContext,
): void {
  server.registerTool(
    "sendMessage",
    {
      title: "Send message",
      description:
        "Send a message as you to one of your conversations. The agent answers in the background. When a turn is running, the message waits for it. Use getConversation to follow the status and last reply.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        message: mcpMessageTextSchema,
        idempotencyKey: mcpIdempotencyKeySchema,
      },
      outputSchema: mcpAcceptedMessageSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
    },
    async ({ conversationId, idempotencyKey, message }) => {
      if (!(await isConversationParticipant(user, conversationId))) {
        return mcpToolError("Conversation not found.");
      }
      try {
        const accepted = await appendConversationMessageForViewer(
          user,
          conversationId,
          { idempotencyKey: idempotencyKey ?? randomUUID(), message },
          { attachmentStorage, queue },
        );
        return mcpToolResult({
          ...accepted,
          url: getDashboardConversationLink(accepted.conversationId),
        });
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
