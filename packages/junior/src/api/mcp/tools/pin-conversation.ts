import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { pinConversation } from "@/api/conversations/pin";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/** Register `pinConversation`, which pins or unpins for the user. */
export function registerPinConversationTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "pinConversation",
    {
      title: "Pin conversation",
      description:
        "Pin one of your top-level conversations, or unpin it. A child conversation cannot be pinned or unpinned; it uses the pin of its root. A pin applies only to you, restores an archived conversation, and keeps auto-archive from archiving it.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        pinned: z
          .boolean()
          .default(true)
          .describe("False unpins the conversation."),
      },
      outputSchema: {
        pinnedAt: z
          .string()
          .nullable()
          .describe("Null when the conversation is not pinned."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ conversationId, pinned }) => {
      try {
        return mcpToolResult(
          await pinConversation(user, conversationId, { pinned }),
        );
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
