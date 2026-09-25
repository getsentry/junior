import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type PluginRegistration,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  LINEAR_ISSUE_EVENTS,
  LINEAR_ISSUE_MATCH_FIELDS,
} from "./events/issue.js";
import { createLinearWebhookRoute } from "./webhooks/handler.js";
import { linearWebhookSecret } from "./webhooks/secret.js";

const namedFact = z
  .union([z.string(), z.object({ name: z.string() })])
  .nullish();
const short = (value: string | undefined) => {
  const text = value?.trim();
  return text ? (text.length > 64 ? `${text.slice(0, 63)}…` : text) : undefined;
};
const factName = (value: z.output<typeof namedFact>) =>
  short(typeof value === "string" ? value : value?.name);

const saveIssueResultSchema = z
  .object({
    issue: z
      .object({
        identifier: z.string().trim().min(1),
        url: z.url(),
        title: z.string().optional(),
        status: z.string().optional(),
        assignee: namedFact,
        priority: z
          .union([z.string(), z.number(), z.object({ name: z.string() })])
          .nullish(),
        project: namedFact,
        cycle: namedFact,
        labels: z.array(namedFact).nullish(),
        dueDate: z.iso.date().nullish(),
        updatedAt: z.iso.datetime({ offset: true }).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

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
  const result = saveIssueResultSchema.safeParse(ctx.result.structuredContent);
  if (!result.success) {
    ctx.log.warn("linear.issue_annotation.skipped", {
      "app.reason": "unexpected_save_response",
    });
    return;
  }
  const identifier = result.data.issue.identifier.toUpperCase();
  const issue = result.data.issue;
  return {
    objectAnnotations: [
      {
        kind: "object",
        objectType: "task",
        key: identifier,
        label: identifier,
        title: (issue.title || identifier).slice(0, 512),
        url: issue.url,
        status: issue.status,
        displayType: "Issue",
        sourceUpdatedAt: issue.updatedAt ?? undefined,
        facts: {
          type: "task",
          assignees:
            issue.assignee === undefined
              ? undefined
              : factName(issue.assignee)
                ? [factName(issue.assignee)!]
                : [],
          priority:
            typeof issue.priority === "number"
              ? ["No priority", "Urgent", "High", "Normal", "Low"][
                  issue.priority
                ]
              : factName(issue.priority),
          project: factName(issue.project),
          cycle: factName(issue.cycle),
          dueDate: issue.dueDate ?? undefined,
          labels: issue.labels
            ?.slice(0, 5)
            .map((label) => factName(label)!)
            .filter(Boolean),
        },
      },
    ],
  };
}

/** Register Linear's hosted MCP provider and conversation-link side effects. */
export function linearPlugin(): PluginRegistration {
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
