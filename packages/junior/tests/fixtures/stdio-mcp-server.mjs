import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "junior-stdio-test-mcp",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    description: "Echo text from a local stdio MCP server",
    inputSchema: {
      value: z.string(),
    },
  },
  ({ value }) => ({
    content: [{ type: "text", text: `echo:${value}` }],
  }),
);

await server.connect(new StdioServerTransport());
