import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type PluginRegistration,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
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

/** Install options for the Linear plugin. */
export interface LinearPluginOptions {
  /**
   * Exact keys of the Linear teams whose issues sync to public GitHub
   * repositories, such as `["SDK", "DOCS"]`. Guardian counts a write to
   * these teams as one the world can read. Other team keys are internal.
   */
  publicTeams?: readonly string[];
}

const TEAM_KEY = /^[A-Z][A-Z0-9]*$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9]*)-\d+$/;

/**
 * What one Linear MCP write names: the `team` of a new issue, or the issue
 * of an edit or comment. Undefined for a call that is not a write. The team
 * is set only when the input names it by its exact key, such as `team: "PY"`
 * or the issue `PY-12`. A team name or a UUID leaves it unknown.
 */
function writeTeam(
  tool: string,
  input: Record<string, unknown>,
): { named: string; key?: string } | undefined {
  if (tool !== "save_issue" && tool !== "save_comment") return undefined;
  const issue = tool === "save_comment" ? input["issueId"] : input["id"];
  const team = tool === "save_issue" ? input["team"] : undefined;
  const named =
    typeof issue === "string" && issue
      ? issue
      : typeof team === "string" && team
        ? team
        : undefined;
  if (!named) return undefined;
  const key =
    named === issue ? ISSUE_KEY.exec(named)?.[1] : TEAM_KEY.exec(named)?.[0];
  return key ? { named, key } : { named };
}

/** Register Linear's hosted MCP provider and conversation-link side effects. */
export function linearPlugin(
  options: LinearPluginOptions = {},
): PluginRegistration {
  const publicTeams = new Set(options.publicTeams);
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
      // The current Guardian reads this fact. The agent Guardian reads the
      // audience that `guardian` gives each write.
      ...(publicTeams.size > 0
        ? {
            reviewContext: `Issues in the Linear teams ${[...publicTeams].join(", ")} sync to public GitHub repositories, so people outside the organization can read their title and description. Other teams are internal.`,
          }
        : undefined),
    },
    hooks: {
      afterMcpTool: annotateSavedIssue,
      // A write named by an exact team key gets that team's audience. A team
      // name or a UUID could be any team, so it counts as `world`.
      async guardian(call) {
        const team =
          call.kind === "mcp" ? writeTeam(call.tool, call.input) : undefined;
        if (!team) return undefined;
        return team.key
          ? {
              target: `Linear team ${team.key}`,
              audience: publicTeams.has(team.key) ? "world" : "internal",
            }
          : { target: `Linear ${team.named}`, audience: "world" };
      },
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
