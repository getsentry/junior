import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type PluginRegistration,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import {
  LINEAR_ISSUE_EVENTS,
  LINEAR_ISSUE_MATCH_FIELDS,
} from "./events/issue.js";
import { linearIssueAnnotation, readLinearIssue } from "./issue-card.js";
import { linearIssueLinks } from "./links/issues.js";
import { createLinearWebhookRoute } from "./webhooks/handler.js";
import { linearWebhookSecret } from "./webhooks/secret.js";

/** Read-only Linear MCP tools that the optional service account may call. */
const LINEAR_SERVICE_ACCOUNT_TOOLS = [
  "extract_images",
  "get_attachment",
  "get_document",
  "get_issue",
  "get_issue_status",
  "get_milestone",
  "get_project",
  "get_team",
  "get_user",
  "list_comments",
  "list_cycles",
  "list_documents",
  "list_issue_labels",
  "list_issue_statuses",
  "list_issues",
  "list_milestones",
  "list_project_labels",
  "list_projects",
  "list_teams",
  "list_users",
  "search_documentation",
] as const;

/** Link created and updated Linear issues to the current Junior conversation. */
async function annotateSavedIssue(
  ctx: AfterMcpToolHookContext,
): Promise<{ objectAnnotations: ObjectAnnotation[] } | void> {
  if (ctx.tool.name !== "save_issue") {
    return;
  }
  if (!ctx.annotations) {
    return;
  }
  const result = readLinearIssue(ctx.result);
  if (!result.success) {
    ctx.log.warn("linear.issue_annotation.skipped", {
      "app.reason": "unexpected_save_response",
    });
    return;
  }
  return { objectAnnotations: [linearIssueAnnotation(result.data)] };
}

/** Install options for the Linear plugin. */
export interface LinearPluginOptions {
  /**
   * Facts for action review about where Linear writes go. For example, say
   * which teams sync issues to public GitHub repositories. Only Guardian reads
   * it.
   */
  reviewContext?: string;
}

/** Register Linear's hosted MCP provider and conversation-link side effects. */
export function linearPlugin(
  options: LinearPluginOptions = {},
): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-linear",
    events: {
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
      // An issue carries its title and description, and a team can be
      // private. So a trigger with no identifier must name its team or one
      // issue.
      events: Object.fromEntries(
        LINEAR_ISSUE_EVENTS.map((eventType) => [
          eventType,
          { reach: { anyOf: ["teamKey", "issueIdentifier"] } },
        ]),
      ),
      isEnabled: () => Boolean(linearWebhookSecret()),
      normalizeIdentifier: (identifier) => identifier.toUpperCase(),
    },
    objectLinks: [linearIssueLinks],
    manifest: {
      // Optional shared read account. It has no effect until an admin
      // connects it on the dashboard Admin page.
      accounts: {
        serviceAccount: { tools: [...LINEAR_SERVICE_ACCOUNT_TOOLS] },
      },
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
      ...(options.reviewContext
        ? { reviewContext: options.reviewContext }
        : undefined),
    },
    hooks: {
      afterMcpTool: annotateSavedIssue,
      routes(ctx) {
        return [
          createLinearWebhookRoute({
            events: ctx.events,
            webhookSecret: linearWebhookSecret,
          }),
        ];
      },
    },
  });
}
