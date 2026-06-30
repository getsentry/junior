import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface EchoMcpTestServer {
  client: Client;
  provider: string;
  rawToolName: string;
  toolName: string;
  close: () => Promise<void>;
}

function modelFacingToolName(provider: string, rawToolName: string): string {
  return `mcp__${provider}__${rawToolName}`;
}

/** Create a real in-memory MCP server/client pair with one echo tool. */
export async function createEchoMcpTestServer(
  provider = "memory",
): Promise<EchoMcpTestServer> {
  const rawToolName = "echo";
  const server = new McpServer({
    name: "junior-test-mcp",
    version: "1.0.0",
  });
  server.registerTool(
    rawToolName,
    {
      description: "Echo text from a local MCP server",
      inputSchema: {
        value: z.string(),
      },
    },
    ({ value }) => ({
      content: [{ type: "text", text: `echo:${value}` }],
    }),
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "junior-memory-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    provider,
    rawToolName,
    toolName: modelFacingToolName(provider, rawToolName),
    close: async () => {
      await client.close();
    },
  };
}
