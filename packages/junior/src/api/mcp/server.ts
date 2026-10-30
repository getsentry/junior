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
import type { User } from "@sentry/junior-plugin-api";
import { JUNIOR_VERSION } from "@/version";
import { registerListConversationsTool } from "./tools/list-conversations";

/** Build the MCP server for one authenticated user. */
function createMcpServer(user: User): McpServer {
  const server = new McpServer({ name: "junior", version: JUNIOR_VERSION });
  registerListConversationsTool(server, user);
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
