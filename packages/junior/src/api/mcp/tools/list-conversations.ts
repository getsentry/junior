import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readConversationFeed } from "@/api/conversations/list";
import { conversationFeedQuerySchema } from "@/api/schema/conversation";
import { mcpConversation, mcpConversationSchema } from "../conversation";
import { mcpToolResult, type McpToolContext } from "../tool-context";

/** Register `listConversations`, which lists the Conversations of the user. */
export function registerListConversationsTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `shape` is the Zod object API.
  const feedQuery = conversationFeedQuerySchema.shape;
  server.registerTool(
    "listConversations",
    {
      title: "List conversations",
      description:
        "List up to 50 of your conversations, newest activity first. Only conversations that you started or take part in are listed.",
      inputSchema: {
        q: feedQuery.q.describe("Text to search for in titles and Briefs."),
        status: feedQuery.status.describe(
          "List conversations that you have not archived (default) or that you archived. A search ignores this filter.",
        ),
      },
      // The SDK checks `structuredContent` against this schema.
      outputSchema: { conversations: z.array(mcpConversationSchema) },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ q, status }) => {
      const feed = await readConversationFeed({ q, status, viewer: user });
      return mcpToolResult({
        conversations: feed.conversations.map(mcpConversation),
      });
    },
  );
}
