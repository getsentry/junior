import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { createLinearIssueTool } from "./tools/create-issue.js";

/** Register Linear's hosted MCP provider and Junior-owned wrapper tools. */
export function linearPlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-linear",
    manifest: {
      configKeys: ["team", "project"],
      description: "Linear issue tracking via hosted MCP server",
      displayName: "Linear",
      mcp: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        wrappedTools: ["create_issue"],
      },
      name: "linear",
    },
    hooks: {
      tools(ctx) {
        return {
          createIssue: createLinearIssueTool(ctx),
        };
      },
    },
  });
}
