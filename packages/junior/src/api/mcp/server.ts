/**
 * Own the MCP server behind `/api/mcp`. A tool that the REST API also serves
 * is an API operation, registered by `tools/api-operation.ts`; each other tool
 * lives in its own file under `tools/`.
 *
 * Each request gets a new server and a stateless transport that answers with
 * JSON. No MCP session or SSE stream outlives the request, so the route works
 * on any app instance and is not limited by the live-stream duration.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { botConfig } from "@/chat/config";
import { getJuniorBuildVersion } from "@/deployment";
import { conversationOperations } from "../conversations/operations";
import type { ApiOperation } from "../operation";
import type { McpScope } from "./oauth/scopes";
import type { McpToolContext } from "./tool-context";
import { registerApiOperationTool } from "./tools/api-operation";
import { registerCreateConversationTool } from "./tools/create-conversation";
import { registerGetAutomationTool } from "./tools/get-automation";
import { registerGetConversationTool } from "./tools/get-conversation";
import { registerGetInboxItemTool } from "./tools/get-inbox-item";
import { registerSearchAutomationsTool } from "./tools/search-automations";
import { registerListConversationMessagesTool } from "./tools/list-conversation-messages";
import { registerMarkConversationReadTool } from "./tools/mark-conversation-read";
import { registerSearchConversationsTool } from "./tools/search-conversations";
import { registerSearchInboxItemsTool } from "./tools/search-inbox-items";
import { registerSendMessageTool } from "./tools/send-message";

type RegisterTool = (server: McpServer, context: McpToolContext) => void;

/** Operations that the REST API also serves. Each names its own scope. */
const OPERATIONS: readonly ApiOperation[] = [...conversationOperations];

/**
 * The hand-written tools that each scope unlocks. A client sees only its
 * granted tools.
 */
const TOOLS_BY_SCOPE: Record<McpScope, readonly RegisterTool[]> = {
  "conversations:read": [
    registerSearchConversationsTool,
    registerGetConversationTool,
    registerListConversationMessagesTool,
  ],
  "conversations:manage": [registerMarkConversationReadTool],
  "conversations:write": [
    registerCreateConversationTool,
    registerSendMessageTool,
  ],
  "inbox_items:read": [registerSearchInboxItemsTool, registerGetInboxItemTool],
  "automations:read": [
    registerSearchAutomationsTool,
    registerGetAutomationTool,
  ],
};

function readInstructions(agentName: string): string {
  return `${agentName} is a Slack agent. These tools read and manage your ${agentName} conversations, and read your inbox items and automations. They cannot send a message or start agent work. To ask ${agentName} for work or to answer an inbox item, use the Slack or dashboard link in a result.`;
}

function writeInstructions(agentName: string): string {
  return `${agentName} is a Slack agent. These tools read and manage your ${agentName} conversations, and read your inbox items and automations. createConversation and sendMessage send a message as you, and ${agentName} works on it in the background. They return a \`cursor\`. Call getConversation with \`after\` set to the newest \`cursor\` to read the new messages. Repeat until \`status\` is not \`active\` and \`hasMore\` is not set. \`authorization\` means a turn waits for you to connect an account. To answer an inbox item, use the dashboard link in a result.`;
}

/** Build the MCP server for one authenticated user and granted scopes. */
function createMcpServer(
  context: McpToolContext,
  scopes: readonly McpScope[],
): McpServer {
  const server = new McpServer(
    { name: "junior", version: getJuniorBuildVersion() },
    {
      instructions: scopes.includes("conversations:write")
        ? writeInstructions(botConfig.userName)
        : readInstructions(botConfig.userName),
    },
  );
  for (const scope of scopes) {
    for (const register of TOOLS_BY_SCOPE[scope]) register(server, context);
  }
  for (const operation of OPERATIONS) {
    if (scopes.includes(operation.scope)) {
      registerApiOperationTool(server, operation, context);
    }
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
