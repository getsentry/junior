import {
  definePluginTool,
  EgressAuthRequired,
  PluginToolInputError,
  type PluginToolExecuteOptions,
  type PluginToolResult,
  type ToolRegistrationHookContext,
  pluginToolResultSchema,
} from "@sentry/junior-plugin-api";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { z } from "zod";
import { appendGitHubFooter } from "./footer.js";
import { appendGitHubRequesterAttribution } from "../tool-support/attribution.js";
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
        description: "Issue body. Junior appends the conversation footer.",
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
      .describe("Issue body. Junior appends the conversation footer.")
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
      number: Type.Number(),
      status: Type.Literal("completed"),
      url: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      createdAtMs: Type.Number(),
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
  number: number;
  url: string;
}

interface GitHubIssueToolResult extends PluginToolResult, GitHubIssueResult {
  ok: true;
  status: "success";
  target: "createIssue";
  data: GitHubIssueResult;
}

const gitHubIssueDataSchema = z.object({
  number: z.number(),
  url: z.string(),
});

const gitHubIssueOutputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.literal("createIssue"),
  data: gitHubIssueDataSchema,
  number: z.number(),
  url: z.string(),
});

function gitHubIssueToolResult(
  result: GitHubIssueResult,
): GitHubIssueToolResult {
  return {
    ok: true,
    status: "success",
    target: "createIssue",
    data: result,
    ...result,
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

function parseRepo(value: string): { name: string; owner: string } {
  const repo = nonEmptyString(value, "repo");
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return {
    owner: parts[0].trim(),
    name: parts[1].trim(),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubApiErrorMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return "GitHub request failed";
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

function createGitHubIssueRequest(
  conversationId: string,
  input: CreateGitHubIssueInput,
  actor: ToolRegistrationHookContext["actor"],
): Request {
  const repo = parseRepo(input.repo);
  const labels = input.labels?.map((label) =>
    nonEmptyString(label, "labels entry"),
  );
  const payload = {
    title: nonEmptyString(input.title, "title"),
    body: appendGitHubFooter(
      appendGitHubRequesterAttribution(input.body ?? "", actor),
      conversationId,
    ),
    ...(labels?.length ? { labels } : {}),
  };
  return new Request(
    `https://api.github.com/repos/${encodeURIComponent(
      repo.owner,
    )}/${encodeURIComponent(repo.name)}/issues`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    },
  );
}

async function createGitHubIssue(
  ctx: ToolRegistrationHookContext,
  request: Request,
): Promise<GitHubIssueResult> {
  const response = await ctx.egress.fetch({
    provider: "github",
    operation: "github.issue.create",
    request,
  });
  const parsed = await readJsonResponse(response);
  if (!response.ok) {
    throw new GitHubIssueCreateRejectedError(
      `GitHub issue creation failed with HTTP ${response.status}: ${githubApiErrorMessage(
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
    number: issue.number,
    url: issue.html_url,
  };
}

/** Own issue creation so provider writes use host egress and the footer stays deterministic. */
export function createGitHubIssueTool(ctx: ToolRegistrationHookContext) {
  return definePluginTool({
    description:
      "Create a GitHub issue with a runtime-owned Junior conversation footer. Use this instead of shelling out to gh issue create when creating issues.",
    inputSchema: createIssueToolInputSchema,
    outputSchema: gitHubIssueOutputSchema,
    async execute(
      input: CreateGitHubIssueInput,
      options: PluginToolExecuteOptions,
    ) {
      const parsedInput = parseCreateIssueInput(input);
      const conversationId = nonEmptyString(
        ctx.conversationId,
        "conversationId",
      );
      const toolCallId = nonEmptyString(options?.toolCallId, "toolCallId");
      const key = `createIssue:${conversationId}:${toolCallId}`;
      return await ctx.state.withLock(
        `${key}:lock`,
        GITHUB_ISSUE_CREATE_LOCK_TTL_MS,
        async () => {
          const state = createIssueState(await ctx.state.get(key));
          if (state?.status === "completed") {
            return gitHubIssueToolResult({
              number: state.number,
              url: state.url,
            });
          }
          if (state?.status === "pending") {
            throw new Error(
              "GitHub issue creation for this tool call has an uncertain pending result; refusing to create a duplicate issue.",
            );
          }
          const request = createGitHubIssueRequest(
            conversationId,
            parsedInput,
            ctx.actor,
          );
          const pendingState: CreateIssueState = {
            status: "pending",
            createdAtMs: Date.now(),
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
                "GitHub issue was created, but Junior could not persist the completed issue state.",
                { cause: error },
              );
            }
            return gitHubIssueToolResult(result);
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
    },
  });
}
