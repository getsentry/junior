import {
  definePluginTool,
  PluginToolInputError,
  type PluginToolDefinition,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const API_URL = "https://api.linear.app/graphql";
const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number().optional(),
  url: z.string(),
  state: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  project: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
});
const issueResultSchema = z.object({ issue: issueSchema });
const issueListResultSchema = z.object({ issues: z.array(issueSchema) });
const teamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});
const projectSchema = z.object({ id: z.string(), name: z.string() });
const workflowStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

type GraphqlEnvelope<T> = { data?: T; errors?: Array<{ message?: string }> };

async function linearGraphql<T>(
  ctx: ToolRegistrationHookContext,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await ctx.egress.fetch({
    provider: "linear",
    operation,
    request: new Request(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  });
  let body: GraphqlEnvelope<T>;
  try {
    body = (await response.json()) as GraphqlEnvelope<T>;
  } catch {
    throw new Error(`Linear returned invalid JSON (HTTP ${response.status}).`);
  }
  const message = body.errors
    ?.map((error) => error.message?.trim())
    .filter(Boolean)
    .join("; ");
  if (!response.ok || message || !body.data) {
    throw new PluginToolInputError(
      message || `Linear request failed with HTTP ${response.status}.`,
    );
  }
  return body.data;
}

const issueSelection = `
  id identifier title description priority url
  state { id name }
  team { id key name }
  project { id name }
`;

function issueInput(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

/** Build Linear's native GraphQL tool surface. */
export function createLinearTools(
  ctx: ToolRegistrationHookContext,
): Record<string, PluginToolDefinition> {
  return {
    getIssue: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Get one Linear issue by UUID or identifier such as ENG-123.",
      inputSchema: z.object({ id: z.string().min(1) }).strict(),
      outputSchema: issueResultSchema,
      async execute({ id }) {
        const data = await linearGraphql<{
          issue: z.input<typeof issueSchema>;
        }>(
          ctx,
          "linear.issue.get",
          `query GetIssue($id: String!) { issue(id: $id) { ${issueSelection} } }`,
          { id },
        );
        return issueResultSchema.parse(data);
      },
    }),
    searchIssues: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Search Linear issue titles and descriptions for duplicate or target resolution.",
      inputSchema: z
        .object({
          query: z.string().min(1),
          first: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      outputSchema: issueListResultSchema,
      async execute({ query, first }) {
        const data = await linearGraphql<{
          issues: { nodes: z.input<typeof issueSchema>[] };
        }>(
          ctx,
          "linear.issue.search",
          `query SearchIssues($query: String!, $first: Int!) { issues(first: $first, filter: { or: [{ title: { containsIgnoreCase: $query } }, { description: { containsIgnoreCase: $query } }] }) { nodes { ${issueSelection} } } }`,
          { query, first },
        );
        return issueListResultSchema.parse({ issues: data.issues.nodes });
      },
    }),
    createIssue: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Create a Linear issue as the installed Junior app. teamId must be a Linear team UUID.",
      inputSchema: z
        .object({
          teamId: z.string().min(1),
          title: z.string().min(1).max(255),
          description: z.string().optional(),
          projectId: z.string().optional(),
          stateId: z.string().optional(),
          assigneeId: z.string().optional(),
          priority: z.number().int().min(0).max(4).optional(),
        })
        .strict(),
      outputSchema: issueResultSchema,
      async execute(input) {
        const data = await linearGraphql<{
          issueCreate: {
            success: boolean;
            issue: z.input<typeof issueSchema> | null;
          };
        }>(
          ctx,
          "linear.issue.create",
          `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${issueSelection} } } }`,
          { input: issueInput(input) },
        );
        if (!data.issueCreate.success || !data.issueCreate.issue) {
          throw new Error("Linear did not create the issue.");
        }
        const result = issueResultSchema.parse({
          issue: data.issueCreate.issue,
        });
        await ctx.annotations?.upsert({
          kind: "resource_link",
          key: result.issue.identifier.toUpperCase(),
          label: result.issue.identifier.toUpperCase(),
          url: result.issue.url,
          status: "open",
        });
        return result;
      },
    }),
    updateIssue: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Update selected fields on an existing Linear issue as the installed Junior app.",
      inputSchema: z
        .object({
          id: z.string().min(1),
          title: z.string().min(1).max(255).optional(),
          description: z.string().nullable().optional(),
          projectId: z.string().nullable().optional(),
          stateId: z.string().optional(),
          assigneeId: z.string().nullable().optional(),
          priority: z.number().int().min(0).max(4).optional(),
        })
        .strict(),
      outputSchema: issueResultSchema,
      async execute({ id, ...update }) {
        if (Object.values(update).every((value) => value === undefined)) {
          throw new PluginToolInputError(
            "At least one issue field must be updated.",
          );
        }
        const data = await linearGraphql<{
          issueUpdate: {
            success: boolean;
            issue: z.input<typeof issueSchema> | null;
          };
        }>(
          ctx,
          "linear.issue.update",
          `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${issueSelection} } } }`,
          { id, input: issueInput(update) },
        );
        if (!data.issueUpdate.success || !data.issueUpdate.issue) {
          throw new Error("Linear did not update the issue.");
        }
        return issueResultSchema.parse({ issue: data.issueUpdate.issue });
      },
    }),
    createComment: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Add a comment to a Linear issue as the installed Junior app.",
      inputSchema: z
        .object({ issueId: z.string().min(1), body: z.string().min(1) })
        .strict(),
      outputSchema: z.object({
        comment: z.object({
          id: z.string(),
          body: z.string(),
          url: z.string().nullable().optional(),
        }),
      }),
      async execute({ issueId, body }) {
        const data = await linearGraphql<{
          commentCreate: {
            success: boolean;
            comment: { id: string; body: string; url?: string | null } | null;
          };
        }>(
          ctx,
          "linear.comment.create",
          `mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body } } }`,
          { input: { issueId, body } },
        );
        if (!data.commentCreate.success || !data.commentCreate.comment) {
          throw new Error("Linear did not create the comment.");
        }
        return { comment: data.commentCreate.comment };
      },
    }),
    listTeams: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "List Linear teams to resolve a team UUID before issue creation.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ teams: z.array(teamSchema) }),
      async execute() {
        const data = await linearGraphql<{
          teams: { nodes: z.input<typeof teamSchema>[] };
        }>(
          ctx,
          "linear.team.list",
          "query ListTeams { teams { nodes { id key name } } }",
          {},
        );
        return { teams: z.array(teamSchema).parse(data.teams.nodes) };
      },
    }),
    listProjects: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description: "List Linear projects to resolve a project UUID.",
      inputSchema: z
        .object({ first: z.number().int().min(1).max(100).default(50) })
        .strict(),
      outputSchema: z.object({ projects: z.array(projectSchema) }),
      async execute({ first }) {
        const data = await linearGraphql<{
          projects: { nodes: z.input<typeof projectSchema>[] };
        }>(
          ctx,
          "linear.project.list",
          "query ListProjects($first: Int!) { projects(first: $first) { nodes { id name } } }",
          { first },
        );
        return { projects: z.array(projectSchema).parse(data.projects.nodes) };
      },
    }),
    listWorkflowStates: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description: "List the workflow states for one Linear team.",
      inputSchema: z.object({ teamId: z.string().min(1) }).strict(),
      outputSchema: z.object({ states: z.array(workflowStateSchema) }),
      async execute({ teamId }) {
        const data = await linearGraphql<{
          team: { states: { nodes: z.input<typeof workflowStateSchema>[] } };
        }>(
          ctx,
          "linear.workflow-state.list",
          "query ListWorkflowStates($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }",
          { teamId },
        );
        return {
          states: z.array(workflowStateSchema).parse(data.team.states.nodes),
        };
      },
    }),
  };
}
