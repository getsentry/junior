import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpHandshakeResponse,
  type McpJsonRpcMessage,
} from "../../msw/handlers/mcp-handshake";
import { mswServer } from "../../msw/server";
import { PluginMcpClient } from "@/chat/mcp/client";
import { parsePluginManifest } from "@/chat/plugins/manifest";

const MCP_URL = "https://header-mcp.example.test/mcp";
const API_KEY_ENV = "TEST_BOT_MCP_API_KEY";
const API_KEY = "bot-api-key";

describe("env-backed MCP headers through PluginMcpClient", () => {
  afterEach(() => {
    delete process.env[API_KEY_ENV];
  });

  it("sends the deployment env value instead of the manifest placeholder", async () => {
    process.env[API_KEY_ENV] = API_KEY;
    mswServer.use(
      http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
      http.post(MCP_URL, async ({ request }) => {
        if (request.headers.get("x-api-key") !== API_KEY) {
          return new HttpResponse(null, { status: 401 });
        }
        return mcpHandshakeResponse(
          (await request.json()) as McpJsonRpcMessage,
          "header-mcp",
        );
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
    } finally {
      await client.close();
    }
  });
});
