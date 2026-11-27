import {
  defineJuniorPlugin,
  type AfterMcpToolHookContext,
  type GuardianResult,
  type PluginRegistration,
  type AnnotatedObject,
} from "@sentry/junior-plugin-api";
import {
  LINEAR_ISSUE_EVENTS,
  LINEAR_ISSUE_MATCH_FIELDS,
} from "./events/issue.js";
import { linearInboxSubjectKinds } from "./inbox-subjects.js";
import { linearSavedIssue, readLinearIssue } from "./issue-card.js";
import { linearIssueLinks } from "./links/issues.js";
import { createLinearWebhookRoute } from "./webhooks/handler.js";
import { linearWebhookSecret } from "./webhooks/secret.js";

/**
 * Read-only Linear MCP tools. The optional service account may call them, and
 * Guardian skips their review.
 */
const LINEAR_READ_TOOLS = [
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
): Promise<{ objectAnnotations: AnnotatedObject[] } | void> {
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
  return {
    objectAnnotations: [
      {
        // save_issue changes the issue that `id` names, else creates one.
        action: ctx.tool.arguments["id"] === undefined ? "created" : "changed",
        ...linearSavedIssue(result.data),
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
  /**
   * Facts for action review about where Linear writes go. For example, say
   * which teams sync issues to public GitHub repositories. Only Guardian reads
   * it.
   */
  reviewContext?: string;
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
  // A named team is where the issue lands, also when the call moves it.
  const named =
    typeof team === "string" && team
      ? team
      : typeof issue === "string" && issue
        ? issue
        : undefined;
  if (!named) return undefined;
  const key =
    named === team ? TEAM_KEY.exec(named)?.[0] : ISSUE_KEY.exec(named)?.[1];
  return key ? { named, key } : { named };
}

/**
 * A write named by an exact team key gets that team's audience. A team
 * name, a UUID, or no team could be any team, so it counts as `world`.
 */
function writeGuardian(
  tool: "save_issue" | "save_comment",
  input: Record<string, unknown>,
  publicTeams: ReadonlySet<string>,
): GuardianResult {
  const team = writeTeam(tool, input);
  if (!team) return { target: "Linear", audience: "world" };
  return team.key
    ? {
        target: `Linear team ${team.key}`,
        audience: publicTeams.has(team.key) ? "world" : "internal",
      }
    : { target: `Linear ${team.named}`, audience: "world" };
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
    objectLinks: [linearIssueLinks],
    manifest: {
      // Optional shared read account. It has no effect until an admin
      // connects it on the dashboard Admin page.
      accounts: {
        serviceAccount: { tools: [...LINEAR_READ_TOOLS] },
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
        // Issue link cards read the issue as the viewer.
        viewerTools: ["get_issue"],
        guardian: { skipReview: [...LINEAR_READ_TOOLS] },
      },
      name: "linear",
      ...(options.reviewContext
        ? { reviewContext: options.reviewContext }
        : undefined),
    },
    inboxSubjects: linearInboxSubjectKinds,
    hooks: {
      afterMcpTool: annotateSavedIssue,
      guardian: {
        tools: {
          save_issue: async (input) =>
            writeGuardian("save_issue", input, publicTeams),
          save_comment: async (input) =>
            writeGuardian("save_comment", input, publicTeams),
        },
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
