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
    description: z.string().nullish(),
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
  .transform((issue, ctx) => {
    // Hosted MCP uses id for the display identifier; a UUID is not a ticket key.
    const identifier = issueIdentifier.safeParse(issue.identifier ?? issue.id);
    if (!identifier.success) {
      ctx.addIssue({ code: "custom", message: "Missing issue identifier" });
      return z.NEVER;
    }
    return { ...issue, identifier: identifier.data.toUpperCase() };
  });
const saveIssueResultSchema = z.union([
  savedIssueSchema,
  z.object({ issue: savedIssueSchema }).transform(({ issue }) => issue),
]);

/** Read Linear's JSON result without inferring issue facts from prose. */
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
): Promise<{ objectAnnotations: ObjectAnnotation[] } | void> {
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
        kind: "object",
        objectType: "task",
        key: identifier,
        label: identifier,
        title: (issue.title || identifier).slice(0, 512),
        description: issue.description?.slice(0, 4000),
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
