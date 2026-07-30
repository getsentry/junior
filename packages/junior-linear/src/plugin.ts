import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { extractLinearIssueLink } from "./extract-issue.js";

function isCreateIssueCall(args: Record<string, unknown>): boolean {
  const id = args.id;
  return id === undefined || id === null || id === "";
}

/** Link newly created Linear issues to the current Junior conversation. */
async function annotateCreatedIssue(
  ctx: AfterMcpToolHookContext,
): Promise<void> {
  if (ctx.tool.name !== "save_issue" || !isCreateIssueCall(ctx.tool.arguments)) {
    return;
  }
  if (!ctx.annotations) {
    return;
  }
  const issue = extractLinearIssueLink(ctx.result);
  if (!issue) {
    return;
  }
  await ctx.annotations.upsert({
    kind: "resource_link",
    key: issue.identifier,
    label: issue.identifier,
    url: issue.url,
    status: "open",
  });
}

/** Register Linear's hosted MCP provider and conversation-link side effects. */
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
      },
      name: "linear",
    },
    hooks: {
      afterMcpTool: annotateCreatedIssue,
    },
  });
}
