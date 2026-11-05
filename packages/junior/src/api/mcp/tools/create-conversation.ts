import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createConversationForViewer } from "@/api/conversations/create";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import {
  mcpAcceptedMessageSchema,
  mcpIdempotencyKeySchema,
  mcpMessageTextSchema,
  readMcpPendingWorkAfterSend,
} from "../conversation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register `createConversation`, which starts a dashboard Conversation with
 * the user's first message. Junior starts a Turn for it.
 */
export function registerCreateConversationTool(
  server: McpServer,
  { attachmentStorage, queue, user }: McpToolContext,
): void {
  server.registerTool(
    "createConversation",
    {
      title: "Create conversation",
      description:
        "Start a new conversation as you, with a first message. The agent works on it in the background. Returns the messages that no turn has read yet. Use getConversation to follow its status and last reply.",
      inputSchema: {
        message: mcpMessageTextSchema,
        visibility: z
          .enum(["private", "public"])
          .default("private")
          .describe(
            "`private` keeps it to its participants. `public` lets people in your workspace find and read it.",
          ),
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
    async ({ idempotencyKey, message, visibility }) => {
      let accepted;
      try {
        accepted = await createConversationForViewer(
          user,
          {
            idempotencyKey: idempotencyKey ?? randomUUID(),
            message,
            visibility,
          },
          { attachmentStorage, queue },
        );
      } catch (error) {
        return apiToolError(error);
      }
      return mcpToolResult({
        ...accepted,
        ...(await readMcpPendingWorkAfterSend(user, accepted.conversationId)),
        url: getDashboardConversationLink(accepted.conversationId),
      });
    },
  );
}
