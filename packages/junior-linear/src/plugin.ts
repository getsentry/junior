import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { createLinearIssueTool } from "./tools/create-issue.js";
import { createLinearUpdateIssueTool } from "./tools/update-issue.js";

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
        wrappedTools: ["save_issue"],
      },
      name: "linear",
    },
    hooks: {
      tools(ctx) {
        return {
          createIssue: createLinearIssueTool(ctx),
          updateIssue: createLinearUpdateIssueTool(ctx),
        };
      },
    },
  });
}
