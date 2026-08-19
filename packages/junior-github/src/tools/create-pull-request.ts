import {
  definePluginTool,
  EgressAuthRequired,
  PluginToolInputError,
  type SubscribableResource,
  type PluginToolExecuteOptions,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { z } from "zod";
import { appendGitHubFooter } from "./footer.js";
import { subscribableResourceSchema } from "@sentry/junior-plugin-api";
import {
  gitHubPullRequestSubscribable,
  type GitHubPullRequestEvent,
} from "../resource-events/pull-request.js";
import { appendGitHubRequesterAttribution } from "../tool-support/attribution.js";
const GITHUB_PULL_REQUEST_CREATE_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GITHUB_PULL_REQUEST_CREATE_LOCK_TTL_MS = 60_000;

class GitHubPullRequestCreateRejectedError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubPullRequestCreateRejectedError";
    this.status = status;
  }
}

const createPullRequestInputSchema = Type.Object(
  {
    repo: Type.String({
      description: 'Repository in "owner/name" format.',
    }),
    title: Type.String({
      description: "Pull request title.",
    }),
    head: Type.String({
      description: "Head branch or owner:branch ref.",
    }),
    base: Type.String({
      description: "Base branch.",
    }),
    body: Type.Optional(
      Type.String({
        description:
          "Pull request body. Junior appends the conversation footer.",
      }),
    ),
    draft: Type.Optional(
      Type.Boolean({
        description: "Whether to open the pull request as a draft.",
      }),
    ),
  },
  { additionalProperties: false },
);
type CreateGitHubPullRequestInput = Static<typeof createPullRequestInputSchema>;

const createPullRequestToolInputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    title: z.string().describe("Pull request title."),
    head: z.string().describe("Head branch or owner:branch ref."),
    base: z.string().describe("Base branch."),
    body: z
      .string()
      .describe("Pull request body. Junior appends the conversation footer.")
      .optional(),
    draft: z
      .boolean()
      .describe("Whether to open the pull request as a draft.")
      .optional(),
  })
  .strict();

const createPullRequestStateSchema = Type.Union([
  Type.Object(
    {
      createdAtMs: Type.Number(),
      input: Type.Optional(createPullRequestInputSchema),
      number: Type.Number(),
      status: Type.Literal("completed"),
      url: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      createdAtMs: Type.Number(),
      input: Type.Optional(createPullRequestInputSchema),
      status: Type.Literal("pending"),
    },
    { additionalProperties: false },
  ),
]);

/**
 * Durable createPullRequest idempotency record; pending blocks retries and
 * completed replays the provider result.
 */
type CreatePullRequestState = Static<typeof createPullRequestStateSchema>;

interface GitHubPullRequestResult {
  number: number;
  url: string;
}

export interface GitHubPullRequestSubscriptionConfig {
  events: GitHubPullRequestEvent[];
  intent: string;
  ttlMs?: number;
}

interface GitHubPullRequestToolResult extends GitHubPullRequestResult {
  subscribable?: SubscribableResource;
  subscription?: { events: string[]; expiresAtMs: number; id: string };
}

interface GitHubPullRequestStructuredResult
  extends PluginToolOutput, GitHubPullRequestToolResult {
  target: "createPullRequest";
}

const gitHubPullRequestDataSchema = z.object({
  number: z.number(),
  url: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  subscription: z
    .object({
      events: z.array(z.string()),
      expiresAtMs: z.number(),
      id: z.string(),
    })
    .optional(),
});

const gitHubPullRequestOutputSchema = pluginToolOutputSchema.extend({
  target: z.literal("createPullRequest"),
  ...gitHubPullRequestDataSchema.shape,
});

function parseCreatePullRequestInput(
  input: unknown,
): CreateGitHubPullRequestInput {
  try {
    return Value.Parse(createPullRequestInputSchema, input);
  } catch (error) {
    throw new PluginToolInputError("Invalid GitHub createPullRequest input.", {
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
      const details = githubApiErrorDetails(payload);
      return details ? `${message}: ${details}` : message;
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return "GitHub request failed";
}

function githubApiErrorDetails(payload: object): string | undefined {
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return undefined;
  }
  const details = errors
    .map((error) => {
      if (!error || typeof error !== "object" || Array.isArray(error)) {
        return undefined;
      }
      const fields = ["resource", "field", "code", "message"]
        .map((name) => {
          const value = (error as Record<string, unknown>)[name];
          return typeof value === "string" && value.trim()
            ? `${name}=${value.trim()}`
            : undefined;
        })
        .filter((value): value is string => value !== undefined);
      return fields.length ? fields.join(" ") : undefined;
    })
    .filter((value): value is string => value !== undefined);
  return details.length ? details.join("; ") : undefined;
}

function createPullRequestState(
  value: unknown,
): CreatePullRequestState | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return Value.Parse(createPullRequestStateSchema, value);
  } catch (error) {
    throw new Error("Invalid GitHub createPullRequest idempotency state.", {
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

function isDefinitiveGitHubPullRequestCreateRejection(
  error: unknown,
): error is GitHubPullRequestCreateRejectedError {
  if (!(error instanceof GitHubPullRequestCreateRejectedError)) {
    return false;
  }
  return [400, 401, 404, 410, 422].includes(error.status);
}

/** Build the GitHub REST create-PR request after Junior owns body/footer shaping. */
async function createGitHubPullRequestRequest(
  conversationId: string,
  input: CreateGitHubPullRequestInput,
  ctx: ToolRegistrationHookContext,
  dashboardUrl?: string,
): Promise<Request> {
  const repo = parseRepo(input.repo);
  const payload = {
    title: nonEmptyString(input.title, "title"),
    head: nonEmptyString(input.head, "head"),
    base: nonEmptyString(input.base, "base"),
    body: appendGitHubFooter(
      await appendGitHubRequesterAttribution(input.body ?? "", ctx),
      conversationId,
      dashboardUrl,
    ),
    ...(input.draft !== undefined ? { draft: input.draft } : {}),
  };
  return new Request(
    `https://api.github.com/repos/${encodeURIComponent(
      repo.owner,
    )}/${encodeURIComponent(repo.name)}/pulls`,
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

async function createGitHubPullRequest(
  ctx: ToolRegistrationHookContext,
  request: Request,
): Promise<GitHubPullRequestResult> {
  const response = await ctx.egress.fetch({
    provider: "github",
    operation: "github.pull.create",
    request,
  });
  const parsed = await readJsonResponse(response);
  if (!response.ok) {
    throw new GitHubPullRequestCreateRejectedError(
      `GitHub pull request creation failed with HTTP ${response.status}: ${githubApiErrorMessage(
        parsed,
      )}`,
      response.status,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "GitHub pull request creation returned an invalid response.",
    );
  }
  const pullRequest = parsed as { html_url?: unknown; number?: unknown };
  if (
    typeof pullRequest.number !== "number" ||
    typeof pullRequest.html_url !== "string"
  ) {
    throw new Error(
      "GitHub pull request creation returned an invalid response.",
    );
  }
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
  };
}

function gitHubPullRequestToolResult(
  input: CreateGitHubPullRequestInput,
  result: GitHubPullRequestResult,
  canSubscribe: boolean,
): GitHubPullRequestToolResult {
  const repo = parseRepo(input.repo);
  const subscribable = canSubscribe
    ? gitHubPullRequestSubscribable({
        number: result.number,
        repo: `${repo.owner}/${repo.name}`,
      })
    : undefined;
  return { ...result, ...(subscribable ? { subscribable } : {}) };
}

async function annotatePullRequest(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubPullRequestInput,
  result: GitHubPullRequestResult,
): Promise<void> {
  const repo = parseRepo(input.repo);
  await ctx.annotations?.upsert({
    kind: "resource_link",
    key: `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${result.number}`,
    label: `${repo.owner}/${repo.name}#${result.number}`,
    url: result.url,
    status: input.draft ? "draft" : "open",
  });
}

async function gitHubPullRequestStructuredResult(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubPullRequestInput,
  result: GitHubPullRequestResult,
  subscriptionConfig?: GitHubPullRequestSubscriptionConfig,
): Promise<GitHubPullRequestStructuredResult> {
  const data = gitHubPullRequestToolResult(
    input,
    result,
    ctx.resourceEvents.canSubscribe,
  );
  const subscription =
    subscriptionConfig && data.subscribable
      ? await ctx.resourceEvents.subscribe({
          events: subscriptionConfig.events,
          intent: subscriptionConfig.intent,
          resource: data.subscribable,
          ...(subscriptionConfig.ttlMs !== undefined
            ? { ttlMs: subscriptionConfig.ttlMs }
            : {}),
        })
      : undefined;
  return {
    target: "createPullRequest",
    ...data,
    ...(subscription ? { subscription } : {}),
  };
}

/** Own PR creation so provider writes use host egress and the footer stays deterministic. */
export function createGitHubPullRequestTool(
  ctx: ToolRegistrationHookContext,
  subscriptionConfig?: GitHubPullRequestSubscriptionConfig,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Create a GitHub pull request with a runtime-owned Junior conversation footer. Use this instead of shelling out to gh pr create when creating pull requests.",
    inputSchema: createPullRequestToolInputSchema,
    outputSchema: gitHubPullRequestOutputSchema,
    async execute(
      input: CreateGitHubPullRequestInput,
      options: PluginToolExecuteOptions,
    ) {
      const parsedInput = parseCreatePullRequestInput(input);
      const conversationId = nonEmptyString(
        ctx.conversationId,
        "conversationId",
      );
      const toolCallId = nonEmptyString(options?.toolCallId, "toolCallId");
      const key = `createPullRequest:${conversationId}:${toolCallId}`;
      return await ctx.state.withLock(
        `${key}:lock`,
        GITHUB_PULL_REQUEST_CREATE_LOCK_TTL_MS,
        async () => {
          const state = createPullRequestState(await ctx.state.get(key));
          if (state?.status === "completed") {
            const completedInput = state.input ?? parsedInput;
            const completedResult = {
              number: state.number,
              url: state.url,
            };
            await annotatePullRequest(ctx, completedInput, completedResult);
            return await gitHubPullRequestStructuredResult(
              ctx,
              completedInput,
              completedResult,
              subscriptionConfig,
            );
          }
          if (state?.status === "pending") {
            throw new Error(
              "GitHub pull request creation for this tool call has an uncertain pending result; refusing to create a duplicate pull request.",
            );
          }
          const request = await createGitHubPullRequestRequest(
            conversationId,
            parsedInput,
            ctx,
            ctx.slack?.conversationLink?.url,
          );
          const pendingState: CreatePullRequestState = {
            status: "pending",
            createdAtMs: Date.now(),
            input: parsedInput,
          };
          await ctx.state.set(
            key,
            pendingState,
            GITHUB_PULL_REQUEST_CREATE_IDEMPOTENCY_TTL_MS,
          );
          try {
            const result = await createGitHubPullRequest(ctx, request);
            Object.assign(pendingState, { status: "completed", ...result });
            try {
              await ctx.state.set(
                key,
                pendingState,
                GITHUB_PULL_REQUEST_CREATE_IDEMPOTENCY_TTL_MS,
              );
            } catch (error) {
              throw new Error(
                "GitHub pull request was created, but Junior could not persist the completed pull request state.",
                { cause: error },
              );
            }
            await annotatePullRequest(ctx, parsedInput, result);
            return await gitHubPullRequestStructuredResult(
              ctx,
              parsedInput,
              result,
              subscriptionConfig,
            );
          } catch (error) {
            if (
              isEgressAuthRequired(error) ||
              isDefinitiveGitHubPullRequestCreateRejection(error)
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
