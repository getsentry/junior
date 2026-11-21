import { githubObjectFacts } from "../object-facts.js";
import { githubObjectAnnotation } from "../annotations.js";
import {
  objectFactsSchema,
  type ObjectAnnotation,
  definePluginTool,
  EgressAuthRequired,
  PluginToolInputError,
  subscribableResourceSchema,
  type SubscribableResource,
  type PluginToolExecuteOptions,
  type WatchResult,
  watchResultSchema,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as z from "zod";
import { appendGitHubFooter } from "../conversation-footer.js";
import { watchGitHubIssue } from "../events/issue.js";
import {
  appendGitHubRequesterAttribution,
  resolveGitHubRequester,
  startedByPerson,
} from "../tool-support/attribution.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";
const GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GITHUB_ISSUE_CREATE_LOCK_TTL_MS = 60_000;

class GitHubIssueCreateRejectedError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubIssueCreateRejectedError";
    this.status = status;
  }
}

const createIssueInputSchema = Type.Object(
  {
    repo: Type.String({
      description: 'Repository in "owner/name" format.',
    }),
    title: Type.String({
      description: "Issue title.",
    }),
    body: Type.Optional(
      Type.String({
        description: "Issue body. The runtime appends the conversation footer.",
      }),
    ),
    labels: Type.Optional(
      Type.Array(Type.String(), {
        description: "Labels to apply to the issue.",
      }),
    ),
  },
  { additionalProperties: false },
);
type CreateGitHubIssueInput = Static<typeof createIssueInputSchema>;

const createIssueToolInputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    title: z.string().describe("Issue title."),
    body: z
      .string()
      .describe("Issue body. The runtime appends the conversation footer.")
      .optional(),
    labels: z
      .array(z.string())
      .describe("Labels to apply to the issue.")
      .optional(),
  })
  .strict();

const createIssueStateSchema = Type.Union([
  Type.Object(
    {
      createdAtMs: Type.Number(),
      input: Type.Optional(createIssueInputSchema),
      number: Type.Number(),
      facts: Type.Optional(Type.Unknown()),
      description: Type.Optional(Type.String({ maxLength: 4000 })),
      sourceUpdatedAt: Type.Optional(Type.String()),
      status: Type.Literal("completed"),
      url: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      createdAtMs: Type.Number(),
      input: Type.Optional(createIssueInputSchema),
      status: Type.Literal("pending"),
    },
    { additionalProperties: false },
  ),
]);

/**
 * Durable createIssue idempotency record; pending blocks retries and completed
 * replays the provider result.
 */
type CreateIssueState = Static<typeof createIssueStateSchema>;

interface GitHubIssueResult {
  facts?: ObjectAnnotation["facts"] | undefined;
  description?: string | undefined;
  sourceUpdatedAt?: string | undefined;
  number: number;
  url: string;
}

interface GitHubIssueData extends GitHubIssueResult {
  note?: string;
  subscribable?: SubscribableResource;
  subscription?: WatchResult;
}

interface GitHubIssueToolResult extends PluginToolOutput, GitHubIssueData {
  target: "createIssue";
}

const gitHubIssueDataSchema = z.object({
  note: z.string().optional(),
  number: z.number(),
  subscribable: subscribableResourceSchema.optional(),
  subscription: watchResultSchema.optional(),
  url: z.string(),
});

const gitHubIssueOutputSchema = pluginToolOutputSchema.merge(
  gitHubIssueDataSchema.extend({
    target: z.literal("createIssue"),
  }),
);

/**
 * Next step after an issue is created. Whether Junior does the work is the
 * requester's decision, so the note asks for a Review item. Only a Turn that
 * a person started gets it: no one can answer the item in other runs.
 */
function implementIssueNote(issue: string): string {
  return `Unless the requester already asked you to fix ${issue}, ask whether to: the choice is theirs, even if they asked only for the issue. Use addReviewItem: question "Start a Thread to implement ${issue}?", choices "Start thread" (recommended) and "Not now", dedupe_key "github-issue-implement:${issue}". If they asked for the fix, start the Thread now. Skip both for issues owned by another team and for security, feedback, or tracking reports. Start the Thread with spawnAgent, kind thread, and this brief: read ${issue} with github_getIssue, follow the github-code workflow, and open a pull request that references it.`;
}

async function gitHubIssueToolResult(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubIssueInput,
  result: GitHubIssueResult,
): Promise<GitHubIssueToolResult> {
  const repo = parseRepo(input.repo);
  const repoName = `${repo.owner}/${repo.name}`;
  const watch = await watchGitHubIssue(ctx, {
    number: result.number,
    repo: repoName,
  });
  const data = {
    ...(startedByPerson(ctx)
      ? { note: implementIssueNote(`${repoName}#${result.number}`) }
      : undefined),
    number: result.number,
    url: result.url,
    ...watch,
  };
  return {
    objectAnnotations: [
      githubObjectAnnotation({
        facts: result.facts,
        description: result.description,
        sourceUpdatedAt: result.sourceUpdatedAt,
        repo: input.repo,
        number: result.number,
        title: input.title,
        url: result.url,
        objectType: "task",
        status: "open",
      }),
    ],
    target: "createIssue",
    ...data,
  };
}

function parseCreateIssueInput(input: unknown): CreateGitHubIssueInput {
  try {
    return Value.Parse(createIssueInputSchema, input);
  } catch (error) {
    throw new PluginToolInputError("Invalid GitHub createIssue input.", {
      cause: error,
    });
  }
}

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new PluginToolInputError(`${name} is required`);
  }
  return value.trim();
}

function createIssueState(value: unknown): CreateIssueState | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return Value.Parse(createIssueStateSchema, value);
  } catch (error) {
    throw new Error("Invalid GitHub createIssue idempotency state.", {
      cause: error,
    });
  }
}

function isEgressAuthRequired(error: unknown): boolean {
  return (
    error instanceof EgressAuthRequired ||
    (error instanceof Error && error.name === "EgressAuthRequired")
  );
}

function isDefinitiveGitHubIssueCreateRejection(
  error: unknown,
): error is GitHubIssueCreateRejectedError {
  if (!(error instanceof GitHubIssueCreateRejectedError)) {
    return false;
  }
  return [400, 401, 404, 410, 422].includes(error.status);
}

async function createGitHubIssueRequest(
  conversationId: string,
  input: CreateGitHubIssueInput,
  ctx: ToolRegistrationHookContext,
  dashboardUrl?: string,
): Promise<{ body: unknown; path: string }> {
  const repo = parseRepo(input.repo);
  const labels = input.labels?.map((label) =>
    nonEmptyString(label, "labels entry"),
  );
  const payload = {
    title: nonEmptyString(input.title, "title"),
    body: appendGitHubFooter(
      appendGitHubRequesterAttribution(
        input.body ?? "",
        await resolveGitHubRequester(ctx),
      ),
      conversationId,
      dashboardUrl,
    ),
    ...(labels?.length ? { labels } : undefined),
  };
  return { path: `${repoPath(repo)}/issues`, body: payload };
}

async function createGitHubIssue(
  ctx: ToolRegistrationHookContext,
  request: { body: unknown; path: string },
): Promise<GitHubIssueResult> {
  const response = await githubApi(ctx.egress, {
    operation: "github.issue.create",
    method: "POST",
    ...request,
  });
  const parsed = response.body;
  if (!response.ok) {
    throw new GitHubIssueCreateRejectedError(
      `GitHub issue creation failed with HTTP ${response.status}: ${githubErrorMessage(
        parsed,
      )}`,
      response.status,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GitHub issue creation returned an invalid response.");
  }
  const issue = parsed as { html_url?: unknown; number?: unknown };
  if (typeof issue.number !== "number" || typeof issue.html_url !== "string") {
    throw new Error("GitHub issue creation returned an invalid response.");
  }
  return {
    ...githubObjectFacts("task", parsed),
    number: issue.number,
    url: issue.html_url,
  };
}

/** Own issue creation so provider writes use host egress and the footer stays deterministic. */
export const gitHubIssueTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Create a GitHub issue with a runtime-owned conversation footer. Use this instead of shelling out to gh issue create when creating issues.",
  inputSchema: createIssueToolInputSchema,
  outputSchema: gitHubIssueOutputSchema,
  async execute(
    input: z.output<typeof createIssueToolInputSchema>,
    options: PluginToolExecuteOptions,
    ctx: ToolRegistrationHookContext,
  ) {
    const parsedInput = parseCreateIssueInput(input);
    const conversationId = nonEmptyString(ctx.conversationId, "conversationId");
    const toolCallId = nonEmptyString(options?.toolCallId, "toolCallId");
    const key = `createIssue:${conversationId}:${toolCallId}`;
    const attempt = await ctx.state.withLock(
      `${key}:lock`,
      GITHUB_ISSUE_CREATE_LOCK_TTL_MS,
      async () => {
        const state = createIssueState(await ctx.state.get(key));
        if (state?.status === "completed") {
          const completedInput = state.input ?? parsedInput;
          const completedResult = {
            facts:
              state.facts === undefined
                ? undefined
                : objectFactsSchema.parse(state.facts),
            sourceUpdatedAt: state.sourceUpdatedAt,
            description: state.description,
            number: state.number,
            url: state.url,
          };
          return await gitHubIssueToolResult(
            ctx,
            completedInput,
            completedResult,
          );
        }
        if (state?.status === "pending") {
          throw new Error(
            "GitHub issue creation for this tool call has an uncertain pending result; refusing to create a duplicate issue.",
          );
        }
        const request = await createGitHubIssueRequest(
          conversationId,
          parsedInput,
          ctx,
          ctx.conversationLink?.url,
        );
        const pendingState: CreateIssueState = {
          status: "pending",
          createdAtMs: Date.now(),
          input: parsedInput,
        };
        await ctx.state.set(
          key,
          pendingState,
          GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS,
        );
        try {
          const result = await createGitHubIssue(ctx, request);
          Object.assign(pendingState, { status: "completed", ...result });
          try {
            await ctx.state.set(
              key,
              pendingState,
              GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS,
            );
          } catch (error) {
            throw new Error(
              "GitHub issue was created, but the runtime could not persist the completed issue state.",
              { cause: error },
            );
          }
          return await gitHubIssueToolResult(ctx, parsedInput, result);
        } catch (error) {
          if (
            isEgressAuthRequired(error) ||
            isDefinitiveGitHubIssueCreateRejection(error)
          ) {
            await ctx.state.delete(key);
          }
          throw error;
        }
      },
    );
    if (!attempt.acquired) {
      throw new Error(
        "GitHub issue creation for this tool call is already running; refusing to create a duplicate issue.",
      );
    }
    return attempt.value;
  },
});
