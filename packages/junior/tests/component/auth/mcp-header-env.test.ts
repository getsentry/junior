import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { mswServer } from "../../msw/server";
import { PluginMcpClient } from "@/chat/mcp/client";
import { parsePluginManifest } from "@/chat/plugins/manifest";

const MCP_URL = "https://header-mcp.example.test/mcp";
const API_KEY_ENV = "TEST_BOT_MCP_API_KEY";
const API_KEY = "bot-api-key";

type JsonRpcMessage = { id?: unknown; method: string };

/** Answer the MCP handshake and list one tool. */
function mcpResponse(message: JsonRpcMessage): Response {
  switch (message.method) {
    case "initialize":
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "header-mcp", version: "1.0.0" },
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

describe("env-backed MCP headers through PluginMcpClient", () => {
  afterEach(() => {
    delete process.env[API_KEY_ENV];
  });

  it("sends the deployment env value instead of the manifest placeholder", async () => {
    process.env[API_KEY_ENV] = API_KEY;
    const receivedKeys = new Set<string | null>();
    mswServer.use(
      http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
      http.post(MCP_URL, async ({ request }) => {
        const apiKey = request.headers.get("x-api-key");
        receivedKeys.add(apiKey);
        if (apiKey !== API_KEY) {
          return new HttpResponse(null, { status: 401 });
        }
        return mcpResponse((await request.json()) as JsonRpcMessage);
      }),
    );
    const manifest = parsePluginManifest(
      [
        "name: header-mcp",
        "display-name: Header MCP",
        "description: MCP server that accepts a shared bot key",
        "env-vars:",
        `  ${API_KEY_ENV}:`,
        "mcp:",
        `  url: ${MCP_URL}`,
        "  headers:",
        `    X-Api-Key: "\${${API_KEY_ENV}}"`,
      ].join("\n"),
      "/plugins/header-mcp",
    );
    const client = new PluginMcpClient({ dir: "/plugins/header-mcp", manifest });

    try {
      const tools = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual(["status"]);
      expect([...receivedKeys]).toEqual([API_KEY]);
    } finally {
      await client.close();
    }
  });
});
