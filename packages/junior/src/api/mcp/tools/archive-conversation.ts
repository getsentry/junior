import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { archiveConversation } from "@/api/conversations/archive";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register `archiveConversation`. It archives or restores a root for the
 * user, or a child Conversation and optionally its children for everyone.
 */
export function registerArchiveConversationTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "archiveConversation",
    {
      title: "Archive conversation",
      description:
        "Archive one of your conversations, or restore it. Archiving a top-level conversation hides it and its child conversations only for you, and writes nothing to the children. Archiving a child conversation, a Thread or a Task, hides it and its children for everyone. A child restore fails while a conversation above it is archived. A new message from a person restores a child and the archived conversations above it.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        archived: z
          .boolean()
          .default(true)
          .describe("False restores an archived conversation."),
        applyToChildren: z
          .boolean()
          .default(false)
          .describe(
            "Child conversations only. True also archives, or restores, every child of this conversation at any depth. Without it, a child archive fails while any of its children is not archived. Ignored for a top-level conversation.",
          ),
        lastSeenAt: z
          .string()
          .datetime()
          .describe(
            "`lastSeenAt` from searchConversations or getConversation. The archive fails when the conversation has newer activity.",
          ),
      },
      outputSchema: {
        archivedAt: z
          .string()
          .nullable()
          .describe("Null when the conversation is not archived."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ applyToChildren, archived, conversationId, lastSeenAt }) => {
      try {
        return mcpToolResult(
          await archiveConversation(user, conversationId, {
            applyToChildren,
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
