import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { readConversationFeed } from "@/api/conversations/list";
import {
  conversationFeedQuerySchema,
  conversationReportStatusSchema,
  conversationSurfaceSchema,
  type ConversationSummaryReport,
} from "@/api/schema/conversation";
import { getDashboardConversationLink } from "@/chat/dashboard-link";

/** MCP view of one Conversation. It omits dashboard-only fields. */
const mcpConversationSchema = z
  .object({
    conversationId: z.string(),
    title: z.string(),
    status: conversationReportStatusSchema,
    surface: conversationSurfaceSchema,
    channelName: z.string().optional(),
    locationUrl: z.string().optional(),
    startedAt: z.string(),
    lastSeenAt: z.string(),
    archivedAt: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

type McpConversation = z.output<typeof mcpConversationSchema>;

function mcpConversation(summary: ConversationSummaryReport): McpConversation {
  return {
    conversationId: summary.conversationId,
    title: summary.displayTitle,
    status: summary.status,
    surface: summary.surface,
    channelName: summary.channelNameRedacted ? undefined : summary.channelName,
    locationUrl: summary.locationUrl,
    startedAt: summary.startedAt,
    lastSeenAt: summary.lastSeenAt,
    archivedAt: summary.archivedAt ?? undefined,
    url: getDashboardConversationLink(summary.conversationId),
  };
}

/** Register `listConversations`, which lists the Conversations of `user`. */
export function registerListConversationsTool(
  server: McpServer,
  user: User,
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ q, status }) => {
      const feed = await readConversationFeed({ q, status, viewer: user });
      const result = { conversations: feed.conversations.map(mcpConversation) };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
