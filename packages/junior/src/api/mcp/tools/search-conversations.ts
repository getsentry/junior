import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { readConversationFeed } from "@/api/conversations/list";
import { conversationFeedQuerySchema } from "@/api/schema/conversation";
import {
  mcpConversation,
  mcpConversationSchema,
} from "../conversation-summary";
import { mcpToolResult, type McpToolContext } from "../tool-context";

/** Register `searchConversations`, which searches the Conversations of the user. */
export function registerSearchConversationsTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `shape` is the Zod object API.
  const feedQuery = conversationFeedQuerySchema.shape;
  server.registerTool(
    "searchConversations",
    {
      title: "Search conversations",
      description:
        "Search your conversations and return up to 50, newest activity first. Only conversations that you started or take part in match.",
      inputSchema: {
        q: feedQuery.q.describe("Text to search for in titles and Briefs."),
        status: feedQuery.status.describe(
          "Return conversations that you have not archived (default) or that you archived. A search ignores this filter.",
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
