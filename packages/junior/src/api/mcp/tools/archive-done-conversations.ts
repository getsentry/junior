import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { archiveViewerDoneConversations } from "@/api/conversations/auto-archive";
import { mcpToolResult, type McpToolContext } from "../tool-context";

/**
 * Register `archiveDoneConversations`, which archives every done
 * Conversation of the user once.
 */
export function registerArchiveDoneConversationsTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "archiveDoneConversations",
    {
      title: "Archive done conversations",
      description:
        "Archive all of your conversations whose work is done, once. It skips pinned conversations, conversations with auto-archive off, and conversations that wait on you. Archiving hides them only for you.",
      inputSchema: {},
      outputSchema: {
        archived: z.number().int().describe("Conversations archived."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async () => mcpToolResult(await archiveViewerDoneConversations(user)),
  );
}
