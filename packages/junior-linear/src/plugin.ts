import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  LINEAR_ISSUE_EVENTS,
  LINEAR_ISSUE_MATCH_FIELDS,
} from "./resource-events/issue.js";
import { createLinearWebhookRoute } from "./webhooks/handler.js";
import { linearWebhookSecret } from "./webhooks/secret.js";

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
    resourceEvents: {
      resourceTypes: [
        {
          type: "issue",
          supportedEvents: [...LINEAR_ISSUE_EVENTS],
          suggestedEvents: [...LINEAR_ISSUE_EVENTS],
          matchFields: LINEAR_ISSUE_MATCH_FIELDS,
        },
        {
          type: "team",
          supportedEvents: [...LINEAR_ISSUE_EVENTS],
          suggestedEvents: [...LINEAR_ISSUE_EVENTS],
          matchFields: LINEAR_ISSUE_MATCH_FIELDS,
        },
      ],
      isEnabled: () => Boolean(linearWebhookSecret()),
      normalizeIdentifier: (identifier) => identifier.toUpperCase(),
    },
    manifest: {
      configKeys: ["team", "project"],
      description:
        "Linear issue tracking via hosted MCP server and issue webhooks",
      displayName: "Linear",
      envVars: {
        LINEAR_WEBHOOK_SECRET: {},
      },
      mcp: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
      },
      name: "linear",
    },
    hooks: {
      afterMcpTool: annotateCreatedIssue,
      routes(ctx) {
        return [
          createLinearWebhookRoute({
            resourceEvents: ctx.resourceEvents,
            webhookSecret: linearWebhookSecret,
          }),
        ];
      },
    },
  });
}
