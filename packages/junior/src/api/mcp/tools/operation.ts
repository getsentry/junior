import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiOperation } from "../../operation";
import {
  apiToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/** Register an API operation that the REST API also serves as an MCP tool. */
export function registerOperationTool(
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
