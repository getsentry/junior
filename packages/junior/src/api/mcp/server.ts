/**
 * Own the MCP server behind `/api/mcp`. Each tool lives in its own file under
 * `tools/`.
 *
 * Each request gets a new server and a stateless transport that answers with
 * JSON. No MCP session or SSE stream outlives the request, so the route works
 * on any app instance and is not limited by the live-stream duration.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { JUNIOR_VERSION } from "@/version";
import type { McpScope } from "./oauth/scopes";
import type { McpToolContext } from "./tool-context";
import { registerArchiveConversationTool } from "./tools/archive-conversation";
import { registerGetAutomationTool } from "./tools/get-automation";
import { registerGetConversationTool } from "./tools/get-conversation";
import { registerGetReviewItemTool } from "./tools/get-review-item";
import { registerSearchAutomationsTool } from "./tools/search-automations";
import { registerListConversationMessagesTool } from "./tools/list-conversation-messages";
import { registerSearchConversationsTool } from "./tools/search-conversations";
import { registerSearchReviewItemsTool } from "./tools/search-review-items";
import { registerStopConversationTool } from "./tools/stop-conversation";

type RegisterTool = (server: McpServer, context: McpToolContext) => void;

/** The tools that each scope unlocks. A client sees only its granted tools. */
const TOOLS_BY_SCOPE: Record<McpScope, readonly RegisterTool[]> = {
  "conversations:read": [
    registerSearchConversationsTool,
    registerGetConversationTool,
    registerListConversationMessagesTool,
  ],
  "conversations:manage": [
    registerArchiveConversationTool,
    registerStopConversationTool,
  ],
  "review_items:read": [
    registerSearchReviewItemsTool,
    registerGetReviewItemTool,
  ],
  "automations:read": [
    registerSearchAutomationsTool,
    registerGetAutomationTool,
  ],
};

const INSTRUCTIONS =
  "Junior is a Slack agent. These tools read your Junior conversations, review items, and automations. They cannot send a message or start agent work. To ask Junior for work or to answer a review item, use the Slack or dashboard link in a result.";

/** Build the MCP server for one authenticated user and granted scopes. */
function createMcpServer(
  context: McpToolContext,
  scopes: readonly McpScope[],
): McpServer {
  const server = new McpServer(
    { name: "junior", version: JUNIOR_VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const scope of scopes) {
    for (const register of TOOLS_BY_SCOPE[scope]) register(server, context);
  }
  return server;
}

/** Answer one Streamable HTTP POST for an authenticated user. */
export async function handleMcpServerRequest(
  request: Request,
  args: McpToolContext & { scopes: readonly McpScope[] },
): Promise<Response> {
  const { scopes, ...context } = args;
  const server = createMcpServer(context, scopes);
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
