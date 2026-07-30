import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const saveIssueResultSchema = z
  .object({
    issue: z
      .object({
        identifier: z.string().trim().min(1),
        url: z.url(),
      })
      .passthrough(),
  })
  .passthrough();

/** Link newly created Linear issues to the current Junior conversation. */
async function annotateCreatedIssue(
  ctx: AfterMcpToolHookContext,
): Promise<void> {
  if (ctx.tool.name !== "save_issue" || ctx.tool.arguments.id !== undefined) {
    return;
  }
  if (!ctx.annotations) {
    return;
  }
  const result = saveIssueResultSchema.safeParse(ctx.result.structuredContent);
  if (!result.success) {
    ctx.log.warn("linear.issue_annotation.skipped", {
      "app.reason": "unexpected_save_response",
    });
    return;
  }
  const identifier = result.data.issue.identifier.toUpperCase();
  await ctx.annotations.upsert({
    kind: "resource_link",
    key: identifier,
    label: identifier,
    url: result.data.issue.url,
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
