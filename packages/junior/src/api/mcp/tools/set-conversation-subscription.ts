import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { setConversationSubscription } from "@/api/conversations/subscription";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register `setConversationSubscription`, which subscribes or unsubscribes
 * the user. It never changes another person's subscription.
 */
export function registerSetConversationSubscriptionTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "setConversationSubscription",
    {
      title: "Set conversation subscription",
      description:
        "Subscribe to one of your conversations, or unsubscribe from it. Unsubscribe removes it only from your feed and clears your pin. When nobody else is subscribed, it archives the conversation for everyone. Your next mention of Junior in it subscribes you again.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        subscribed: z.boolean().describe("False unsubscribes you."),
      },
      outputSchema: {
        archivedAt: z
          .string()
          .nullable()
          .describe("Set when the conversation is archived for everyone."),
        subscribed: z.boolean(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ conversationId, subscribed }) => {
      try {
        return mcpToolResult(
          await setConversationSubscription(user, conversationId, {
            subscribed,
          }),
        );
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
