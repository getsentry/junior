import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiOperation } from "../../operation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register an API operation as an MCP tool. A client error from the
 * operation becomes a tool error.
 */
export function registerApiOperationTool(
  server: McpServer,
  operation: ApiOperation,
  { queue, user }: McpToolContext,
): void {
  server.registerTool(
    operation.name,
    {
      title: operation.title,
      description: operation.description,
      inputSchema: operation.input,
      outputSchema: operation.output,
      annotations: { ...operation.annotations, openWorldHint: false },
    },
    async (input) => {
      try {
        return mcpToolResult(await operation.run(user, input, { queue }));
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
