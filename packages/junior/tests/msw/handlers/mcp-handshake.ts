import { HttpResponse } from "msw";

export interface McpJsonRpcMessage {
  id?: unknown;
  method: string;
}

/** Answer the MCP handshake and list one tool, for MSW-backed MCP server fakes. */
export function mcpHandshakeResponse(
  message: McpJsonRpcMessage,
  serverName: string,
): Response {
  switch (message.method) {
    case "initialize":
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "1.0.0" },
        },
      });
    case "notifications/initialized":
      return new HttpResponse(null, { status: 202 });
    case "tools/list":
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "status",
              description: "Pipeline status",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    default:
      return HttpResponse.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "unsupported" },
        },
        { status: 400 },
      );
  }
}
