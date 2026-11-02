import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { archiveConversation } from "@/api/conversations/archive";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/** Register `archiveConversation`, which archives or restores for the user. */
export function registerArchiveConversationTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "archiveConversation",
    {
      title: "Archive conversation",
      description:
        "Archive one of your conversations, or restore it. Archiving hides it only for you, and new activity restores it.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        archived: z
          .boolean()
          .default(true)
          .describe("False restores an archived conversation."),
        lastSeenAt: z
          .string()
          .datetime()
          .describe(
            "`lastSeenAt` from listConversations or getConversation. The archive fails when the conversation has newer activity.",
          ),
      },
      outputSchema: { archivedAt: z.string().nullable() },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ archived, conversationId, lastSeenAt }) => {
      try {
        return mcpToolResult(
          await archiveConversation(user, conversationId, {
            archived,
            lastSeenAt,
          }),
        );
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
