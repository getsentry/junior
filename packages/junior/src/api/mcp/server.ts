/**
 * Own the MCP server behind `/api/mcp` and its one tool.
 *
 * Each request gets a new server and a stateless transport that answers with
 * JSON. No MCP session or SSE stream outlives the request, so the route works
 * on any app instance and is not limited by the live-stream duration.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { readConversationFeed } from "@/api/conversations/list";
import type { ConversationSummaryReport } from "@/api/schema/conversation";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { JUNIOR_VERSION } from "@/version";

/** MCP view of one Conversation. It omits dashboard-only fields. */
const mcpConversationSchema = z
  .object({
    conversationId: z.string(),
    title: z.string(),
    status: z.enum(["active", "completed", "failed"]),
    surface: z.enum(["api", "internal", "scheduler", "slack"]),
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
  const url = getDashboardConversationLink(summary.conversationId);
  return mcpConversationSchema.parse({
    conversationId: summary.conversationId,
    title: summary.displayTitle,
    status: summary.status,
    surface: summary.surface,
    ...(summary.channelName && !summary.channelNameRedacted
      ? { channelName: summary.channelName }
      : undefined),
    ...(summary.locationUrl ? { locationUrl: summary.locationUrl } : undefined),
    startedAt: summary.startedAt,
    lastSeenAt: summary.lastSeenAt,
    ...(summary.archivedAt ? { archivedAt: summary.archivedAt } : undefined),
    ...(url ? { url } : undefined),
  });
}

function conversationSummaryText(conversations: McpConversation[]): string {
  if (conversations.length === 0) return "No conversations found.";
  return conversations
    .map(
      (conversation) =>
        `- ${conversation.title} (${conversation.status}) ${conversation.url ?? conversation.conversationId}`,
    )
    .join("\n");
}

/** Build the MCP server for one authenticated user. */
function createMcpServer(user: User): McpServer {
  const server = new McpServer({ name: "junior", version: JUNIOR_VERSION });
  server.registerTool(
    "listConversations",
    {
      title: "List conversations",
      description:
        "List up to 50 of your conversations, newest activity first. Only conversations that you started or take part in are listed.",
      inputSchema: {
        q: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Text to search for in titles and Briefs."),
        status: z
          .enum(["active", "archived"])
          .optional()
          .describe(
            "List conversations that you have not archived (default) or that you archived. A search ignores this filter.",
          ),
      },
      outputSchema: { conversations: z.array(mcpConversationSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ q, status }) => {
      const feed = await readConversationFeed({
        viewer: user,
        ...(q ? { q } : undefined),
        ...(status ? { status } : undefined),
      });
      const conversations = feed.conversations.map(mcpConversation);
      return {
        content: [
          { type: "text", text: conversationSummaryText(conversations) },
        ],
        structuredContent: { conversations },
      };
    },
  );
  return server;
}

/** Answer one Streamable HTTP POST for an authenticated user. */
export async function handleMcpServerRequest(
  request: Request,
  user: User,
): Promise<Response> {
  const server = createMcpServer(user);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
