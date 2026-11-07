import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { setConversationAutoArchive } from "@/api/conversations/auto-archive";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register `setConversationAutoArchive`, which overrides the user's
 * auto-archive default for one Conversation.
 */
export function registerSetConversationAutoArchiveTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "setConversationAutoArchive",
    {
      title: "Set conversation auto-archive",
      description:
        "Turn auto-archive on or off for one of your conversations. This overrides your default for that conversation only.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        autoArchive: z
          .boolean()
          .describe(
            "True lets auto-archive archive the conversation for everyone after its work is done. False keeps it from auto-archive for everyone.",
          ),
      },
      outputSchema: { autoArchive: z.boolean() },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ autoArchive, conversationId }) => {
      try {
        return mcpToolResult(
          await setConversationAutoArchive(user, conversationId, autoArchive),
        );
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
