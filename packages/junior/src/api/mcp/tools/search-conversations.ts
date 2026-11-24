import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { readConversationFeed } from "@/api/conversations/list";
import {
  conversationFeedQuerySchema,
  type ConversationFeedItem,
} from "@/api/schema/conversation-feed";
import { mcpConversation, mcpConversationSchema } from "../conversation";
import { mcpToolResult, type McpToolContext } from "../tool-context";

type McpFeedConversation = z.output<typeof mcpConversationSchema> & {
  threads?: McpFeedConversation[];
};

// A feed row with its visible Threads. The feed nests them with the access
// of their root, so a client sees only the Threads it may see.
const mcpFeedConversationSchema: z.ZodType<McpFeedConversation> =
  mcpConversationSchema.extend({
    threads: z
      .lazy(() => z.array(mcpFeedConversationSchema))
      .optional()
      .describe(
        "Threads under this conversation, newest activity first, each with its own `threads`. Tasks are left out. Set only with `includeThreads`.",
      ),
  });

function mcpFeedConversation(item: ConversationFeedItem): McpFeedConversation {
  return {
    ...mcpConversation(item),
    ...(item.threads?.length
      ? { threads: item.threads.map(mcpFeedConversation) }
      : undefined),
  };
}

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
        q: feedQuery.q.describe(
          "Text to search for in titles, summaries, and Annotation labels and titles.",
        ),
        status: feedQuery.status.describe(
          "Return conversations that are not archived (default) or that are archived. A search ignores this filter.",
        ),
        includeThreads: z
          .boolean()
          .optional()
          .describe(
            "True nests the Threads of each conversation under it in `threads`.",
          ),
      },
      // The SDK checks `structuredContent` against this schema.
      outputSchema: { conversations: z.array(mcpFeedConversationSchema) },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ includeThreads, q, status }) => {
      const feed = await readConversationFeed({ q, status, viewer: user });
      return mcpToolResult({
        conversations: feed.conversations.map((item) =>
          includeThreads ? mcpFeedConversation(item) : mcpConversation(item),
        ),
      });
    },
  );
}
