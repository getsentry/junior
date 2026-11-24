import pLimit from "p-limit";
import { githubObjectFacts } from "../object-facts.js";
import { githubObjectAnnotation } from "../annotations.js";
import {
  objectFactsSchema,
  type ObjectAnnotation,
  definePluginTool,
  EgressAuthRequired,
  PluginToolInputError,
  type WatchResult,
  type SubscribableResource,
  type PluginToolExecuteOptions,
  type PluginToolOutput,
  type PluginWorkOwner,
  type ToolRegistrationHookContext,
  pluginToolOutputSchema,
  watchResultSchema,
  subscribableResourceSchema,
} from "@sentry/junior-plugin-api";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as z from "zod";
import { appendGitHubFooter } from "../conversation-footer.js";
import {
  gitHubPullRequestCreateWatch,
  gitHubPullRequestSubscribable,
  type GitHubPullRequestSubscriptionConfig,
} from "../events/pull-request.js";
import {
  appendGitHubRequesterAttribution,
  assertGitHubPullRequestRequester,
  linkedGitHubLogin,
  parseGitHubLogin,
  requesterPerson,
  resolveGitHubRequester,
} from "../tool-support/attribution.js";
import type { GitHubDb } from "../db/database.js";
import { saveGitHubDraftReviewers } from "../pull-request-requesters/draft-reviewers.js";
import { recordGitHubPullRequestOpener } from "../pull-request-requesters/store.js";
import {
  stackGitHubPullRequest,
  stackTargetSchema,
  type GitHubPullRequestStack,
  type GitHubStackTarget,
} from "../tool-support/stack-pull-request.js";
import {
  checkPullRequestDescription,
  PULL_REQUEST_BODY_RULES,
} from "../tool-support/pull-request-description.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";
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

const BODY_DESCRIPTION = `Pull request body. ${PULL_REQUEST_BODY_RULES}`;
const REVIEWERS_DESCRIPTION =
  "People to ask for a review: GitHub logins, emails, Slack mentions, or names. A person maps to their linked GitHub login. Set it only when the person names a reviewer. Without it, the tool asks the requester. A draft is asked once ready.";
const ASSIGNEES_DESCRIPTION =
  "People to assign: GitHub logins, emails, Slack mentions, or names. A person maps to their linked GitHub login. Set this only when the person or instruction names who to assign. Without it, the tool assigns the requester's linked GitHub account.";

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
        description: BODY_DESCRIPTION,
      }),
    ),
    draft: Type.Optional(
      Type.Boolean({
        description: "Whether to open the pull request as a draft.",
      }),
    ),
    reviewers: Type.Optional(
      Type.Array(Type.String(), {
        description: REVIEWERS_DESCRIPTION,
        minItems: 1,
      }),
    ),
    assignees: Type.Optional(
      Type.Array(Type.String(), {
        description: ASSIGNEES_DESCRIPTION,
        minItems: 1,
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
    body: z.string().describe(BODY_DESCRIPTION).optional(),
    draft: z
      .boolean()
      .describe("Whether to open the pull request as a draft.")
      .optional(),
    reviewers: z
      .array(z.string())
      .min(1)
      .describe(REVIEWERS_DESCRIPTION)
      .optional(),
    assignees: z
      .array(z.string())
      .min(1)
      .describe(ASSIGNEES_DESCRIPTION)
      .optional(),
  })
  .strict();

const createPullRequestStateSchema = Type.Union([
  Type.Object(
    {
      createdAtMs: Type.Number(),
      input: Type.Optional(createPullRequestInputSchema),
      number: Type.Number(),
      /** GitHub's id of the pull request, for its opener's row. */
      pullRequestId: Type.Optional(Type.String()),
      facts: Type.Optional(Type.Unknown()),
      sourceUpdatedAt: Type.Optional(Type.String()),
      description: Type.Optional(Type.String({ maxLength: 4000 })),
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
  facts?: ObjectAnnotation["facts"] | undefined;
  sourceUpdatedAt?: string | undefined;
  description?: string | undefined;
  number: number;
  url: string;
}

interface GitHubPullRequestToolResult extends GitHubPullRequestResult {
  stack?: GitHubPullRequestStack;
  subscribable?: SubscribableResource;
  subscription?: WatchResult;
}

interface GitHubPullRequestStructuredResult
  extends PluginToolOutput, GitHubPullRequestToolResult {
  target: "createPullRequest";
}

const gitHubPullRequestDataSchema = z.object({
  number: z.number(),
  url: z.string(),
  stack: z
    .object({ number: z.number(), pull_requests: z.array(z.number()) })
    .optional(),
  subscribable: subscribableResourceSchema.optional(),
  subscription: watchResultSchema.optional(),
});

const gitHubPullRequestOutputSchema = pluginToolOutputSchema.merge(
  gitHubPullRequestDataSchema.extend({
    target: z.literal("createPullRequest"),
  }),
);

function parseCreatePullRequestInput(
  input: unknown,
): CreateGitHubPullRequestInput {
  try {
    return Value.Parse(createPullRequestInputSchema, input);
  } catch (error) {
    throw new PluginToolInputError(
      "Invalid GitHub createPullRequest input. Check the arguments against the tool schema and call it again.",
      {
        cause: error,
      },
    );
  }
}

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new PluginToolInputError(
      `${name} must not be empty. Set it and call the tool again.`,
    );
  }
  return value.trim();
}

function runtimeId(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new PluginToolInputError(
      `${name} is missing in this Turn. No change to the call can fix this.`,
    );
  }
  return value.trim();
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

function isDefinitiveGitHubPullRequestCreateRejection(error: unknown): boolean {
  if (error instanceof PluginToolInputError) {
    return true;
  }
  if (!(error instanceof GitHubPullRequestCreateRejectedError)) {
    return false;
  }
  return [400, 401, 410].includes(error.status);
}

/** Build the GitHub REST create-PR request after the runtime owns body/footer shaping. */
function createGitHubPullRequestRequest(
  conversationId: string,
  input: CreateGitHubPullRequestInput,
  requester: PluginWorkOwner | undefined,
  dashboardUrl?: string,
): { body: unknown; path: string } {
  const repo = parseRepo(input.repo);
  const payload = {
    title: nonEmptyString(input.title, "title"),
    head: nonEmptyString(input.head, "head"),
    base: nonEmptyString(input.base, "base"),
    body: appendGitHubFooter(
      appendGitHubRequesterAttribution(input.body ?? "", requester),
      conversationId,
      dashboardUrl,
    ),
    ...(input.draft !== undefined ? { draft: input.draft } : undefined),
  };
  return { path: `${repoPath(repo)}/pulls`, body: payload };
}

async function createGitHubPullRequest(
  ctx: ToolRegistrationHookContext,
  request: { body: unknown; path: string },
): Promise<{
  pullRequestId?: string;
  result: GitHubPullRequestResult;
  stackTarget?: GitHubStackTarget;
}> {
  const response = await githubApi(ctx.egress, {
    operation: "github.pull.create",
    method: "POST",
    ...request,
  });
  const parsed = response.body;
  if (!response.ok) {
    const message = `GitHub pull request creation failed with HTTP ${response.status}: ${githubErrorMessage(
      parsed,
    )}`;
    // 404 and 422 mean the model named a missing repo or branch, or GitHub
    // rejected the requested change. The model can fix the input and retry.
    if (response.status === 404 || response.status === 422) {
      throw new PluginToolInputError(
        `${message}. Check repo, head, and base, and fix any field that GitHub names.`,
      );
    }
    throw new GitHubPullRequestCreateRejectedError(message, response.status);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "GitHub pull request creation returned an invalid response.",
    );
  }
  const pullRequest = parsed as {
    html_url?: unknown;
    id?: unknown;
    number?: unknown;
  };
  if (
    typeof pullRequest.number !== "number" ||
    typeof pullRequest.html_url !== "string"
  ) {
    throw new Error(
      "GitHub pull request creation returned an invalid response.",
    );
  }
  const stackTarget = stackTargetSchema.safeParse(parsed);
  return {
    result: {
      ...githubObjectFacts("code_change", parsed),
      number: pullRequest.number,
      url: pullRequest.html_url,
    },
    ...(typeof pullRequest.id === "number"
      ? { pullRequestId: String(pullRequest.id) }
      : undefined),
    ...(stackTarget.success ? { stackTarget: stackTarget.data } : undefined),
  };
}

/**
 * Save the opener of a pull request GitHub opened. A create with no Junior
 * identity has no opener.
 */
async function recordOpener(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubPullRequestInput,
  state: { createdAtMs: number; number: number; pullRequestId?: string },
  requester: { conversationId: string; identityId: string | undefined },
): Promise<void> {
  const { conversationId, identityId } = requester;
  if (!identityId) return;
  const repo = parseRepo(input.repo);
  await recordGitHubPullRequestOpener(ctx.db as GitHubDb, {
    conversationId,
    createdAt: new Date(state.createdAtMs),
    identityId,
    number: state.number,
    pullRequestId: state.pullRequestId,
    repositoryFullName: repo.ref,
  });
}

/**
 * Assign the named assignees, or else the requester. Assignment is optional:
 * provider failures must not fail PR creation.
 */
async function assignPullRequest(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubPullRequestInput,
  result: GitHubPullRequestResult,
  requester: PluginWorkOwner | undefined,
): Promise<void> {
  const requesterLogin = linkedGitHubLogin(requesterPerson(requester)?.user);
  const assignees =
    namedLogins(input.assignees, "assignee") ??
    (requesterLogin ? [requesterLogin] : []);
  if (assignees.length === 0) return;
  try {
    const repo = parseRepo(input.repo);
    const response = await githubApi(ctx.egress, {
      operation: "github.pull.assign",
      method: "POST",
      path: `${repoPath(repo)}/issues/${result.number}/assignees`,
      body: { assignees },
    });
    if (!response.ok) {
      ctx.log.warn("github.pull_request.assign_after_create.rejected", {
        number: result.number,
        repo: input.repo,
        status: response.status,
      });
    }
    // GitHub may ignore an ineligible assignee. An unassigned PR is acceptable.
  } catch (error) {
    ctx.log.warn("github.pull_request.assign_after_create.failed", {
      error: error instanceof Error ? error.message : String(error),
      number: result.number,
      repo: input.repo,
    });
  }
}

/**
 * Replace each named assignee or reviewer that is not a GitHub login, such as
 * an email, a Slack mention, or a name, with the linked GitHub login of the
 * person it names. Reject a value that no linked account verifies, before
 * GitHub opens the pull request.
 */
async function resolveNamedPeople(
  ctx: ToolRegistrationHookContext,
  people: {
    assignees?: string[] | undefined;
    reviewers?: string[] | undefined;
  },
): Promise<{ assignees?: string[]; reviewers?: string[] }> {
  const [assignees, reviewers] = await Promise.all([
    resolveLogins(ctx, people.assignees, "assignee"),
    resolveLogins(ctx, people.reviewers, "reviewer"),
  ]);
  return {
    ...(assignees ? { assignees } : undefined),
    ...(reviewers ? { reviewers } : undefined),
  };
}

// Each lookup can search Slack, so a long list does not fan out at once.
const PERSON_LOOKUP_CONCURRENCY = 4;

async function resolveLogins(
  ctx: ToolRegistrationHookContext,
  values: string[] | undefined,
  role: "assignee" | "reviewer",
): Promise<string[] | undefined> {
  if (!values) return undefined;
  return await pLimit(PERSON_LOOKUP_CONCURRENCY).map(values, async (value) => {
    const login = parseGitHubLogin(value);
    if (login) return login;
    const lookup = await ctx.users.findLinkedHandle(value, "github");
    const linked =
      lookup.status === "found" ? parseGitHubLogin(lookup.handle) : undefined;
    if (linked) return linked;
    throw new PluginToolInputError(
      lookup.status === "ambiguous"
        ? `More than one person matches ${role} ${value}. Name one person.`
        : lookup.status === "unlinked"
          ? `${role} ${value} has no linked GitHub account. Pass their GitHub login.`
          : `No person matches ${role} ${value}. Pass a GitHub login.`,
    );
  });
}

/** Return the logins of named reviewers or assignees. */
function namedLogins(
  values: string[] | undefined,
  role: "assignee" | "reviewer",
): string[] | undefined {
  return values?.map((value) => {
    const login = parseGitHubLogin(value);
    if (!login) {
      throw new PluginToolInputError(
        `Invalid GitHub ${role} login: ${value}. Pass a GitHub login, such as octocat.`,
      );
    }
    return login;
  });
}

/**
 * Save the reviewers named for a draft, so the ready_for_review webhook asks
 * them. With nothing saved, that webhook asks the requester.
 */
async function saveNamedDraftReviewers(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubPullRequestInput,
  number: number,
): Promise<void> {
  const named = namedLogins(input.reviewers, "reviewer");
  if (!input.draft || !named) return;
  await saveGitHubDraftReviewers(
    ctx.state,
    { number, repositoryFullName: parseRepo(input.repo).ref },
    named,
  );
}

/**
 * Ask the named reviewers, or else the requester, to review a new pull
 * request. A draft waits until it is ready for review. The request is
 * optional: provider failures must not fail PR creation.
 */
async function requestPullRequestReviewers(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubPullRequestInput,
  result: GitHubPullRequestResult,
  requester: PluginWorkOwner | undefined,
): Promise<void> {
  const named = namedLogins(input.reviewers, "reviewer");
  const repo = parseRepo(input.repo);
  try {
    if (input.draft) {
      await saveNamedDraftReviewers(ctx, input, result.number);
      return;
    }
    const requesterLogin = linkedGitHubLogin(requesterPerson(requester)?.user);
    const reviewers = named ?? (requesterLogin ? [requesterLogin] : []);
    if (reviewers.length === 0) return;
    const response = await githubApi(ctx.egress, {
      operation: "github.pull.request_reviewers",
      method: "POST",
      path: `${repoPath(repo)}/pulls/${result.number}/requested_reviewers`,
      body: { reviewers },
    });
    if (!response.ok) {
      ctx.log.warn(
        "github.pull_request.request_reviewers_after_create.rejected",
        {
          number: result.number,
          repo: input.repo,
          status: response.status,
        },
      );
    }
  } catch (error) {
    ctx.log.warn("github.pull_request.request_reviewers_after_create.failed", {
      error: error instanceof Error ? error.message : String(error),
      number: result.number,
      repo: input.repo,
    });
  }
}

function gitHubPullRequestToolResult(
  input: CreateGitHubPullRequestInput,
  result: GitHubPullRequestResult,
  canSubscribe: boolean,
  omitSuggestedEvents?: readonly string[],
): GitHubPullRequestToolResult {
  const repo = parseRepo(input.repo);
  const subscribable = gitHubPullRequestSubscribable({
    canSubscribe,
    number: result.number,
    repo: `${repo.owner}/${repo.name}`,
    ...(omitSuggestedEvents ? { omitSuggestedEvents } : undefined),
  });
  return {
    number: result.number,
    url: result.url,
    ...(subscribable ? { subscribable } : undefined),
  };
}

async function gitHubPullRequestStructuredResult(
  ctx: ToolRegistrationHookContext,
  input: CreateGitHubPullRequestInput,
  result: GitHubPullRequestResult,
  subscriptionConfig?: GitHubPullRequestSubscriptionConfig,
  stack?: GitHubPullRequestStack,
): Promise<GitHubPullRequestStructuredResult> {
  // Subscribe first. Only prune suggested events after a successful forced
  // subscription so a failed side effect still leaves the created PR usable.
  const base = gitHubPullRequestToolResult(
    input,
    result,
    ctx.events.canSubscribe,
  );
  const objectAnnotations = [
    githubObjectAnnotation({
      facts: result.facts,
      sourceUpdatedAt: result.sourceUpdatedAt,
      description: result.description,
      repo: input.repo,
      number: result.number,
      title: input.title,
      url: result.url,
      objectType: "code_change",
      status: input.draft ? "draft" : "open",
    }),
  ];
  if (!subscriptionConfig || !base.subscribable) {
    return {
      objectAnnotations,
      target: "createPullRequest",
      ...base,
      ...(stack ? { stack } : undefined),
    };
  }
  const watch = gitHubPullRequestCreateWatch(subscriptionConfig, {
    draft: input.draft === true,
  });
  try {
    const subscription = await ctx.events.subscribe({
      ...watch,
      resource: base.subscribable,
    });
    // Quiet Events stay suggested, so the agent can still watch a merge
    // when a person asks to hear about it.
    const data = gitHubPullRequestToolResult(
      input,
      result,
      ctx.events.canSubscribe,
      subscription.events,
    );
    return {
      objectAnnotations,
      target: "createPullRequest",
      ...data,
      ...(stack ? { stack } : undefined),
      subscription,
    };
  } catch (error) {
    ctx.log.warn("github.pull_request.subscribe_after_create.failed", {
      error: error instanceof Error ? error.message : String(error),
      number: result.number,
      repo: input.repo,
    });
    return {
      objectAnnotations,
      target: "createPullRequest",
      ...base,
      ...(stack ? { stack } : undefined),
    };
  }
}

/** Own PR creation so provider writes use host egress and the footer stays deterministic. */
export function createGitHubPullRequestTool(
  subscriptionConfig?: GitHubPullRequestSubscriptionConfig,
  /** Set when the description check experiment is on. */
  descriptionChecks = false,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Create a GitHub pull request with a runtime-owned conversation footer. By default it assigns the pull request to the requester's linked GitHub account and asks for a review when available. Use this instead of shelling out to gh pr create when creating pull requests.",
    exposure: "direct",
    inputSchema: createPullRequestToolInputSchema,
    outputSchema: gitHubPullRequestOutputSchema,
    async execute(
      input: z.output<typeof createPullRequestToolInputSchema>,
      options: PluginToolExecuteOptions,
      ctx: ToolRegistrationHookContext,
    ) {
      // People fields skip the Slack mention rewrite that other text gets:
      // an unlinked person's mention would become a name and lose the Slack
      // user ID that the lookup needs.
      const { assignees, reviewers, ...text } = input;
      const [githubText, people] = await Promise.all([
        ctx.users.replaceSlackMentions(text, "github"),
        resolveNamedPeople(ctx, { assignees, reviewers }),
      ]);
      const parsedInput = parseCreatePullRequestInput({
        ...githubText,
        ...people,
      });
      const conversationId = runtimeId(ctx.conversationId, "conversationId");
      const toolCallId = runtimeId(options?.toolCallId, "toolCallId");
      const key = `createPullRequest:${conversationId}:${toolCallId}`;
      const attempt = await ctx.state.withLock(
        `${key}:lock`,
        GITHUB_PULL_REQUEST_CREATE_LOCK_TTL_MS,
        async () => {
          const state = createPullRequestState(await ctx.state.get(key));
          if (state?.status === "completed") {
            const completedInput = state.input ?? parsedInput;
            // The call can stop after it saves this state but before it saves
            // the opener, so a retry saves the opener again.
            const requester = await resolveGitHubRequester(ctx);
            await recordOpener(ctx, completedInput, state, {
              conversationId,
              identityId: requesterPerson(requester)?.identity?.id,
            });
            // The same stop can drop the reviewers named for a draft.
            await saveNamedDraftReviewers(ctx, completedInput, state.number);
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
          const requester = await resolveGitHubRequester(ctx);
          assertGitHubPullRequestRequester(requester);
          if (descriptionChecks) {
            await checkPullRequestDescription(
              ctx.decider,
              parsedInput.body ?? "",
            );
          }
          const identityId = requesterPerson(requester)?.identity?.id;
          const request = createGitHubPullRequestRequest(
            conversationId,
            parsedInput,
            requester,
            ctx.conversationLink?.url,
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
          let result: GitHubPullRequestResult;
          let pullRequestId: string | undefined;
          let stackTarget: GitHubStackTarget | undefined;
          try {
            ({ pullRequestId, result, stackTarget } =
              await createGitHubPullRequest(ctx, request));
          } catch (error) {
            if (
              isEgressAuthRequired(error) ||
              isDefinitiveGitHubPullRequestCreateRejection(error)
            ) {
              await ctx.state.delete(key);
            }
            throw error;
          }
          const completedState: Extract<
            CreatePullRequestState,
            { status: "completed" }
          > = {
            ...pendingState,
            status: "completed",
            number: result.number,
            ...(pullRequestId === undefined ? undefined : { pullRequestId }),
            url: result.url,
            facts: result.facts,
            ...(result.sourceUpdatedAt === undefined
              ? undefined
              : { sourceUpdatedAt: result.sourceUpdatedAt }),
            ...(result.description === undefined
              ? undefined
              : { description: result.description }),
          };
          try {
            await ctx.state.set(
              key,
              completedState,
              GITHUB_PULL_REQUEST_CREATE_IDEMPOTENCY_TTL_MS,
            );
          } catch (error) {
            throw new Error(
              "GitHub pull request was created, but the runtime could not persist the completed pull request state.",
              { cause: error },
            );
          }
          await recordOpener(ctx, parsedInput, completedState, {
            conversationId,
            identityId,
          });
          await assignPullRequest(ctx, parsedInput, result, requester);
          await requestPullRequestReviewers(
            ctx,
            parsedInput,
            result,
            requester,
          );
          const stack = stackTarget
            ? await stackGitHubPullRequest(ctx, stackTarget)
            : undefined;
          return await gitHubPullRequestStructuredResult(
            ctx,
            parsedInput,
            result,
            subscriptionConfig,
            stack,
          );
        },
      );
      if (!attempt.acquired) {
        throw new Error(
          "GitHub pull request creation for this tool call is already running; refusing to create a duplicate pull request.",
        );
      }
      return attempt.value;
    },
  });
}
