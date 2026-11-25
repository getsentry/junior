import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type PluginRegistration,
  type AnnotatedObject,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  LINEAR_ISSUE_EVENTS,
  LINEAR_ISSUE_MATCH_FIELDS,
} from "./events/issue.js";
import {
  LINEAR_SUBJECT_KINDS,
  linearInboxSubjectKinds,
} from "./inbox-subjects.js";
import { createLinearWebhookRoute } from "./webhooks/handler.js";
import { linearWebhookSecret } from "./webhooks/secret.js";

const issueIdentifier = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9]*-\d+$/i);
const savedIssueSchema = z
  .object({
    identifier: issueIdentifier.optional(),
    id: z.string().optional(),
    url: z.url(),
    title: z.string().optional(),
  })
  .transform((issue, ctx) => {
    // Hosted MCP uses id for the display identifier; a UUID is not a ticket key.
    const identifier = issueIdentifier.safeParse(issue.identifier ?? issue.id);
    if (!identifier.success) {
      ctx.addIssue({ code: "custom", message: "Missing issue identifier" });
      return z.NEVER;
    }
    return { ...issue, identifier: identifier.data.toUpperCase() };
  });

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

const saveIssueResultSchema = z.union([
  savedIssueSchema,
  z.object({ issue: savedIssueSchema }).transform(({ issue }) => issue),
]);

/** Read Linear's JSON result without inferring the issue from prose. */
function readSavedIssue(result: AfterMcpToolHookContext["result"]) {
  if (result.structuredContent !== undefined) {
    return saveIssueResultSchema.safeParse(result.structuredContent);
  }
  for (const part of result.content ?? []) {
    if (part.type !== "text") continue;
    let value: unknown;
    try {
      value = JSON.parse(part.text);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const parsed = saveIssueResultSchema.safeParse(value);
    if (parsed.success) return parsed;
  }
  return saveIssueResultSchema.safeParse(undefined);
}

/** Link created and updated Linear issues to the current Junior conversation. */
async function annotateSavedIssue(
  ctx: AfterMcpToolHookContext,
): Promise<{ objectAnnotations: AnnotatedObject[] } | void> {
  if (ctx.tool.name !== "save_issue") {
    return;
  }
  if (!ctx.annotations) {
    return;
  }
  const result = readSavedIssue(ctx.result);
  if (!result.success) {
    ctx.log.warn("linear.issue_annotation.skipped", {
      "app.reason": "unexpected_save_response",
    });
    return;
  }
  const issue = result.data;
  const identifier = issue.identifier;
  return {
    objectAnnotations: [
      {
        // save_issue changes the issue that `id` names, else creates one.
        action: ctx.tool.arguments["id"] === undefined ? "created" : "changed",
        kind: "object",
        objectType: "task",
        key: identifier,
        subject: { id: identifier, kind: LINEAR_SUBJECT_KINDS.issue },
        title: (issue.title || identifier).slice(0, 512),
        url: issue.url,
      },
    ],
  };
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
    inboxSubjects: linearInboxSubjectKinds,
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
