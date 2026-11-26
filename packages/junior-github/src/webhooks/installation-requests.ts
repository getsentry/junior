/**
 * GitHub requests that webhook handling makes with installation tokens.
 *
 * A webhook delivery has no Turn and no egress context, so these requests
 * call GitHub directly. Other plugin code must use host egress.
 */
import {
  graphqlReactionContent,
  pullRequestCommentReactionsPath,
  pullRequestFeedbackReactionContent,
  pullRequestReviewPath,
} from "../pull-request-feedback.js";
import type { PluginCache, PluginState } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GitHubRequestError,
  githubRequest,
  issueInstallationToken,
} from "../credential-support.js";
import { githubGraphqlRequest } from "./graphql-request.js";
import type { InstallationTokens } from "../installation-tokens.js";
import {
  ADD_REVIEW_REACTION,
  OPEN_PULL_REQUEST_MERGEABILITY,
  PULL_REQUEST_CONFLICT_HISTORY,
  PULL_REQUEST_NEXT_ACTION,
  PULL_REQUEST_REVIEWS_BEFORE,
  pullRequestHeadFacts,
  pullRequestLifecycles,
} from "../graphql-documents.js";
import {
  type PullRequestRef,
  pullRequestVariables,
} from "../pull-request-graphql.js";
import type { GitHubRead } from "../pull-request-review-again.js";
import { githubErrorMessage } from "../tool-support/github-api.js";

/** Environment variable names for the GitHub App installation. */
export interface GitHubInstallationEnv {
  appIdEnv: string;
  installationIdEnv: string;
  privateKeyEnv: string;
  /** Saved GET responses, as in `sendConditionalRequest`. */
  responses?: PluginState | undefined;
  /** Tokens to reuse, as in `reuseInstallationToken`. */
  tokens?: InstallationTokens | undefined;
}

function splitRepository(fullName: string, label: string) {
  const [owner, name, ...extra] = fullName.split("/");
  if (!owner || !name || extra.length > 0) {
    throw new Error(`GitHub ${label} received an invalid repository name`);
  }
  return { owner, name };
}

/** Return a reader for pages of a pull request's commits, with a read-only token. */
export async function loadPullRequestCommitPages(
  env: GitHubInstallationEnv,
  pullRequest: { number: number; repositoryFullName: string },
): Promise<(page: number, perPage: number) => Promise<unknown>> {
  const { owner, name } = splitRepository(
    pullRequest.repositoryFullName,
    "pull request commits",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "read" },
    repositories: [name],
  });
  return async (page, perPage) =>
    await githubRequest(
      "https://api.github.com",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest.number}/commits?per_page=${perPage}&page=${page}`,
      { responses: env.responses, token: token.token },
    );
}

/** Read one pull request, with a read-only token. */
export async function loadPullRequest(
  env: GitHubInstallationEnv,
  pullRequest: { number: number; repositoryFullName: string },
): Promise<unknown> {
  const { owner, name } = splitRepository(
    pullRequest.repositoryFullName,
    "pull request",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "read" },
    repositories: [name],
  });
  return await githubRequest(
    "https://api.github.com",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest.number}`,
    { responses: env.responses, token: token.token },
  );
}

const rateLimitSchema = z.object({
  resources: z.object({ graphql: z.object({ reset: z.number().int() }) }),
});

/**
 * Read when the installation's GraphQL rate limit resets, with the same
 * read-only token as the pull request reads. GitHub does not count this
 * read against the rate limit.
 */
export async function loadGraphqlRateLimitReset(
  env: GitHubInstallationEnv,
  repositoryFullName: string,
): Promise<Date> {
  const { name } = splitRepository(repositoryFullName, "rate limit");
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "read" },
    repositories: [name],
  });
  const response = rateLimitSchema.parse(
    await githubRequest("https://api.github.com", "/rate_limit", {
      token: token.token,
    }),
  );
  return new Date(response.resources.graphql.reset * 1000);
}

/**
 * Return a reader of repository full names by repository id, with one
 * metadata-only token for every repository of the installation. The reader
 * returns undefined when GitHub does not find the repository.
 */
export async function loadRepositoryFullNames(
  env: GitHubInstallationEnv,
): Promise<(repositoryId: string) => Promise<string | undefined>> {
  const token = await issueInstallationToken({
    ...env,
    permissions: { metadata: "read" },
  });
  return async (repositoryId) => {
    try {
      return z
        .object({ full_name: z.string().min(1) })
        .parse(
          await githubRequest(
            "https://api.github.com",
            `/repositories/${encodeURIComponent(repositoryId)}`,
            { token: token.token },
          ),
        ).full_name;
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  };
}

/** GitHub cannot reach a repository: it is gone, or the installation lost it. */
export class GitHubRepositoryUnreachableError extends Error {
  constructor(repositoryId: number) {
    super(`GitHub repository ${repositoryId} is not reachable`);
    this.name = "GitHubRepositoryUnreachableError";
  }
}

// GitHub answers a token request for a repository that the installation
// cannot reach with 422 and this message.
const UNREACHABLE_REPOSITORY_MESSAGE = /does not exist or is not accessible/i;

/**
 * Read the lifecycle of some pull requests of one repository in one GraphQL
 * query, with a read-only token. Each pull request has the alias `pr<index>`.
 * The repository is found by its id, because a rename changes its name.
 */
export async function loadPullRequestLifecycles(
  env: GitHubInstallationEnv,
  input: { numbers: number[]; repositoryId: number },
): Promise<unknown> {
  let token: { token: string };
  try {
    token = await issueInstallationToken({
      ...env,
      permissions: { pull_requests: "read" },
      repositoryIds: [input.repositoryId],
    });
  } catch (error) {
    if (
      error instanceof GitHubRequestError &&
      error.status === 422 &&
      UNREACHABLE_REPOSITORY_MESSAGE.test(error.message)
    ) {
      throw new GitHubRepositoryUnreachableError(input.repositoryId);
    }
    throw error;
  }
  const repository = z
    .object({ full_name: z.string().min(1) })
    .parse(
      await githubRequest(
        "https://api.github.com",
        `/repositories/${input.repositoryId}`,
        { token: token.token },
      ),
    );
  const { owner, name } = splitRepository(
    repository.full_name,
    "pull request lifecycle",
  );
  return await githubGraphqlRequest({
    body: {
      ...pullRequestLifecycles(input.numbers.length),
      variables: {
        name,
        owner,
        ...Object.fromEntries(
          input.numbers.map((number, index) => [`n${index}`, number]),
        ),
      },
    },
    token: token.token,
  });
}

/**
 * Read one page of a repository's open pull requests by one author, with
 * their mergeability, through GraphQL search and a read-only token.
 */
export async function searchOpenPullRequestMergeability(
  env: GitHubInstallationEnv,
  input: {
    after?: string | undefined;
    author: string;
    repositoryFullName: string;
  },
): Promise<unknown> {
  const { name } = splitRepository(
    input.repositoryFullName,
    "pull request mergeability",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "read" },
    repositories: [name],
  });
  return await githubGraphqlRequest({
    body: {
      ...OPEN_PULL_REQUEST_MERGEABILITY,
      variables: {
        after: input.after ?? null,
        query: `repo:${input.repositoryFullName} is:pr is:open author:${input.author}`,
      },
    },
    token: token.token,
  });
}

/**
 * Read the merge state and check counts of pull requests by repository and
 * number, in one aliased query, with a read-only token.
 */
export async function loadPullRequestHeadFacts(
  env: GitHubInstallationEnv,
  refs: PullRequestRef[],
): Promise<unknown> {
  const token = await issueInstallationToken({
    ...env,
    permissions: { checks: "read", pull_requests: "read" },
  });
  return await githubGraphqlRequest({
    body: {
      ...pullRequestHeadFacts(refs.length),
      variables: pullRequestVariables(refs),
    },
    token: token.token,
  });
}

/** Read the merge conflict history of one pull request, with a read-only token. */
export async function loadPullRequestConflictHistory(
  env: GitHubInstallationEnv,
  pullRequest: { number: number; repositoryFullName: string },
): Promise<unknown> {
  const { owner, name } = splitRepository(
    pullRequest.repositoryFullName,
    "pull request conflict history",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "read" },
    repositories: [name],
  });
  return await githubGraphqlRequest({
    body: {
      ...PULL_REQUEST_CONFLICT_HISTORY,
      variables: { name, number: pullRequest.number, owner },
    },
    token: token.token,
  });
}

/** Ask people to review one pull request, with a pull request write token. */
export async function requestPullRequestReviewers(
  env: GitHubInstallationEnv,
  input: { number: number; repositoryFullName: string; reviewers: string[] },
): Promise<void> {
  const { owner, name } = splitRepository(
    input.repositoryFullName,
    "pull request review request",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "write" },
    repositories: [name],
  });
  await githubRequest(
    "https://api.github.com",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${input.number}/requested_reviewers`,
    {
      body: { reviewers: input.reviewers },
      method: "POST",
      token: token.token,
    },
  );
}

/**
 * Return a read-only GitHub reader for one repository, for the review-again
 * check: GraphQL for the pull request, and REST for the branch rules.
 */
export async function loadReviewAgainReader(
  env: GitHubInstallationEnv,
  repositoryFullName: string,
): Promise<GitHubRead> {
  const { name } = splitRepository(repositoryFullName, "review again");
  const token = await issueInstallationToken({
    ...env,
    permissions: {
      checks: "read",
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    },
    repositories: [name],
  });
  return async (request) =>
    await githubRequest("https://api.github.com", request.path, {
      ...(request.body === undefined
        ? { responses: env.responses }
        : { body: request.body, method: "POST" }),
      token: token.token,
    });
}

/** Add the "reviewing" reaction to one pull request comment or review body. */
export async function markPullRequestFeedbackReviewing(
  env: GitHubInstallationEnv,
  target: {
    commentId: number;
    commentKind: "conversation" | "review" | "review_body";
    pullRequest: number;
    repo: string;
  },
): Promise<void> {
  const { owner, name } = splitRepository(target.repo, "pull request feedback");
  const token = await issueInstallationToken({
    ...env,
    repositories: [name],
  });
  const content = pullRequestFeedbackReactionContent("reviewing");
  if (target.commentKind === "review_body") {
    // A review body has no REST reactions endpoint, so react to its node.
    const review = z.object({ node_id: z.string().min(1) }).parse(
      await githubRequest(
        "https://api.github.com",
        pullRequestReviewPath({
          owner,
          name,
          pullRequest: target.pullRequest,
          reviewId: target.commentId,
        }),
        { token: token.token },
      ),
    );
    // GraphQL reports errors with HTTP 200.
    const result = z.object({ errors: z.array(z.unknown()).optional() }).parse(
      await githubRequest("https://api.github.com", "/graphql", {
        body: {
          ...ADD_REVIEW_REACTION,
          variables: {
            content: graphqlReactionContent(content),
            subjectId: review.node_id,
          },
        },
        method: "POST",
        token: token.token,
      }),
    );
    if (result.errors?.length) {
      throw new Error(
        `GitHub review reaction failed: ${githubErrorMessage(result)}`,
      );
    }
    return;
  }
  await githubRequest(
    "https://api.github.com",
    pullRequestCommentReactionsPath({
      owner,
      name,
      commentKind: target.commentKind,
      commentId: target.commentId,
    }),
    {
      body: { content },
      method: "POST",
      token: token.token,
    },
  );
}

const repositoryPermissionSchema = z.object({
  permission: z.string().min(1),
  role_name: z.string().optional(),
});

// Roles change rarely. A removed maintainer can keep their role this long.
const REPOSITORY_ROLE_TTL_MS = 10 * 60 * 1000;

type RepositoryTarget = { login: string; repositoryFullName: string };

/**
 * Read one user's access to a repository, with a metadata-only token: their
 * role, and GitHub's base permission of that role. GitHub returns "none" for
 * accounts without access, such as most bots. It is cached for ten minutes.
 */
async function loadRepositoryAccess(
  env: GitHubInstallationEnv,
  cache: PluginCache,
  target: RepositoryTarget,
): Promise<{ permission: string; role: string }> {
  const { owner, name } = splitRepository(
    target.repositoryFullName,
    "repository role",
  );
  return await cache.getOrLoad(
    // Not `repository-access:`, which `repository-access.ts` keeps a boolean
    // under in the same plugin cache.
    `repository-permission:${owner}/${name}:${target.login}`.toLowerCase(),
    async () => {
      const token = await issueInstallationToken({
        ...env,
        permissions: { metadata: "read" },
        repositories: [name],
      });
      const response = repositoryPermissionSchema.parse(
        await githubRequest(
          "https://api.github.com",
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(target.login)}/permission`,
          { responses: env.responses, token: token.token },
        ),
      );
      // role_name includes maintain, triage, and custom roles. permission
      // is the base of the role: admin, write, read, or none.
      return {
        value: {
          permission: response.permission,
          role: response.role_name?.trim() || response.permission,
        },
        ttlMs: REPOSITORY_ROLE_TTL_MS,
      };
    },
  );
}

/** Read one user's role on a repository, such as `maintain` or a custom role. */
export async function loadRepositoryRole(
  env: GitHubInstallationEnv,
  cache: PluginCache,
  target: RepositoryTarget,
): Promise<string> {
  return (await loadRepositoryAccess(env, cache, target)).role;
}

/**
 * Whether GitHub lets a user merge pull requests in a repository: the base
 * permission of their role, custom roles too, is write or admin. A login
 * that GitHub does not know, such as a renamed account, cannot merge.
 */
export async function canMergeInRepository(
  env: GitHubInstallationEnv,
  cache: PluginCache,
  target: RepositoryTarget,
): Promise<boolean> {
  try {
    const { permission } = await loadRepositoryAccess(env, cache, target);
    return permission === "admin" || permission === "write";
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

const timestampSchema = z.iso.datetime({ offset: true });

// GitHub can return a null node for a deleted or hidden item, so the
// connection lists drop them.
function nodesSchema<T extends z.ZodType>(node: T) {
  return z
    .array(node.nullable())
    .transform((items) =>
      items.filter((item): item is NonNullable<typeof item> => item !== null),
    );
}

const actorSchema = z
  .object({ __typename: z.string(), login: z.string().min(1) })
  .nullable();
const reviewsSchema = z.object({
  pageInfo: z.object({
    hasPreviousPage: z.boolean(),
    startCursor: z.string().nullable(),
  }),
  nodes: nodesSchema(
    z.object({
      author: actorSchema,
      state: z.string(),
      submittedAt: timestampSchema.nullable(),
    }),
  ),
});
const userLoginSchema = z
  .object({ __typename: z.string(), login: z.string().min(1).optional() })
  .nullable();

const nextActionSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        autoMergeRequest: z.object({}).nullable(),
        commits: z.object({
          nodes: nodesSchema(
            z.object({ commit: z.object({ committedDate: timestampSchema }) }),
          ),
        }),
        isDraft: z.boolean(),
        mergeStateStatus: z.string(),
        reviewRequests: z.object({
          nodes: nodesSchema(z.object({ requestedReviewer: userLoginSchema })),
        }),
        reviews: reviewsSchema,
        state: z.enum(["CLOSED", "MERGED", "OPEN"]),
        timelineItems: z.object({
          nodes: nodesSchema(
            z.discriminatedUnion("__typename", [
              z.object({
                __typename: z.literal("IssueComment"),
                author: actorSchema,
                createdAt: timestampSchema,
              }),
              z.object({
                __typename: z.literal("ReviewRequestedEvent"),
                createdAt: timestampSchema,
                requestedReviewer: userLoginSchema,
              }),
              z.object({
                __typename: z.literal("ReviewRequestRemovedEvent"),
                actor: actorSchema,
                createdAt: timestampSchema,
                requestedReviewer: userLoginSchema,
              }),
            ]),
          ),
        }),
        title: z.string(),
        url: z.string().url(),
      }),
    }),
  }),
});

const reviewsPageSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({ reviews: reviewsSchema }),
    }),
  }),
});

/**
 * One thing that a person or an App did on a pull request: `author` wrote a
 * comment or review, and `reviewRequest` asked `login` for a review. `login`
 * is the REST login, so a bot ends in `[bot]`.
 */
export interface GitHubPullRequestActivity {
  at: Date;
  /**
   * `author`: a comment or a review by `login`. `reviewRequest`: GitHub
   * asked `login` for a review. `reviewRequestRemoved`: `login` removed
   * their own review request.
   */
  kind: "author" | "reviewRequest" | "reviewRequestRemoved";
  login: string;
  /** The state of an `author` review, such as `COMMENTED`. */
  review?: string;
}

/** The pull request facts that decide its next action. */
export interface GitHubPullRequestMergeState {
  /**
   * The latest comments, reviews, and review requests, in no order. GitHub
   * returns the latest 100 comments and review requests.
   */
  activity: GitHubPullRequestActivity[];
  /** A person turned on auto-merge, so GitHub merges it without them. */
  autoMerge: boolean;
  draft: boolean;
  /** When the head commit was made, as the time of the last push. */
  headCommittedAt?: Date;
  /**
   * The requester's latest review that approves or requests changes
   * approves it. Read for drafts too, from the last 100 reviews, because the
   * requester marks an approved draft ready.
   */
  requesterApproved: boolean;
  /**
   * GitHub's merge state, such as `clean` or `blocked`. `clean` means that
   * the required reviews and every check and status passed, and there are
   * no conflicts. Undefined when GitHub has not computed it yet.
   */
  mergeableState?: string;
  /** Logins of the people whose review GitHub still requests. */
  requestedReviewers: string[];
  /**
   * GitHub still requests a review from a person or a team. A team that
   * the App cannot read has no login, so `requestedReviewers` misses it.
   */
  reviewPending: boolean;
  /**
   * Logins of the people whose latest submitted review was not dismissed,
   * including a comment-only review. Read only when the pull request is open
   * and not a draft.
   */
  reviewedBy: string[];
  /**
   * `approved` with at least one approval and no reviewer who still
   * requests changes. `changesRequested` while a reviewer still requests
   * changes. Undefined with neither. Read only when the pull request is
   * open and not a draft.
   */
  reviewOutcome?: "approved" | "changesRequested";
  state: "closed" | "merged" | "open";
  title: string;
  url: string;
}

// GraphQL gives a bot's login without the `[bot]` that REST and webhooks add.
function restLogin(actor: { __typename: string; login: string }): string {
  return actor.__typename === "Bot" ? `${actor.login}[bot]` : actor.login;
}

type Review = z.output<typeof reviewsSchema>["nodes"][number];

/**
 * Read whether a pull request is ready to merge, whether the requester
 * changed their review, and who acted on it last, with a read-only token
 * and one GraphQL query. GitHub computes the merge state after a change,
 * so an unknown state is read once more. A pull request with more than 100
 * reviews reads the older pages too. Each reviewer counts by their latest
 * approval, change request, or dismissal. Comments do not change the
 * result.
 */
export async function loadPullRequestMergeState(
  env: GitHubInstallationEnv,
  pullRequest: { number: number; repositoryFullName: string },
  requesterLogin: string | undefined,
): Promise<GitHubPullRequestMergeState> {
  const { owner, name } = splitRepository(
    pullRequest.repositoryFullName,
    "pull request merge state",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "read" },
    repositories: [name],
  });
  const variables = { name, number: pullRequest.number, owner };
  const query = async (
    document: typeof PULL_REQUEST_NEXT_ACTION,
    extra?: { before: string },
  ) =>
    await githubGraphqlRequest({
      body: { ...document, variables: { ...variables, ...extra } },
      token: token.token,
    });
  const readPull = async () =>
    nextActionSchema.parse(await query(PULL_REQUEST_NEXT_ACTION)).data
      .repository.pullRequest;
  let pull = await readPull();
  const open = pull.state === "OPEN" && !pull.isDraft;
  const unknown = (status: string) => status === "UNKNOWN";
  if (open && !pull.autoMergeRequest && unknown(pull.mergeStateStatus)) {
    pull = await readPull();
  }
  const reviews: Review[] = [...pull.reviews.nodes];
  let page = pull.reviews.pageInfo;
  // Older pages can hold a reviewer's latest change request.
  while (open && page.hasPreviousPage && page.startCursor) {
    const older = reviewsPageSchema.parse(
      // oxlint-disable-next-line no-await-in-loop -- Each page starts at the cursor of the page after it.
      await query(PULL_REQUEST_REVIEWS_BEFORE, { before: page.startCursor }),
    ).data.repository.pullRequest.reviews;
    reviews.unshift(...older.nodes);
    page = older.pageInfo;
  }

  const activity: GitHubPullRequestActivity[] = [];
  for (const item of pull.timelineItems.nodes) {
    if (item.__typename === "IssueComment" && item.author) {
      activity.push({
        at: new Date(item.createdAt),
        kind: "author",
        login: restLogin(item.author),
      });
    } else if (
      item.__typename === "ReviewRequestedEvent" &&
      item.requestedReviewer?.login
    ) {
      activity.push({
        at: new Date(item.createdAt),
        kind: "reviewRequest",
        login: item.requestedReviewer.login,
      });
    } else if (
      item.__typename === "ReviewRequestRemovedEvent" &&
      item.requestedReviewer?.login &&
      item.actor &&
      restLogin(item.actor).toLowerCase() ===
        item.requestedReviewer.login.toLowerCase()
    ) {
      activity.push({
        at: new Date(item.createdAt),
        kind: "reviewRequestRemoved",
        login: item.requestedReviewer.login,
      });
    }
  }
  for (const review of reviews) {
    if (review.author && review.submittedAt) {
      activity.push({
        at: new Date(review.submittedAt),
        kind: "author",
        login: restLogin(review.author),
        review: review.state,
      });
    }
  }

  const mergeableState = unknown(pull.mergeStateStatus)
    ? undefined
    : pull.mergeStateStatus.toLowerCase();
  const headCommittedAt = pull.commits.nodes[0]?.commit.committedDate;
  const state: GitHubPullRequestMergeState = {
    activity,
    autoMerge: Boolean(pull.autoMergeRequest),
    draft: pull.isDraft,
    ...(headCommittedAt
      ? { headCommittedAt: new Date(headCommittedAt) }
      : undefined),
    ...(mergeableState ? { mergeableState } : undefined),
    requesterApproved: false,
    requestedReviewers: pull.reviewRequests.nodes.flatMap((request) =>
      request.requestedReviewer?.__typename === "User" &&
      request.requestedReviewer.login
        ? [request.requestedReviewer.login]
        : [],
    ),
    reviewPending: pull.reviewRequests.nodes.length > 0,
    reviewedBy: [],
    state:
      pull.state === "MERGED"
        ? "merged"
        : pull.state === "OPEN"
          ? "open"
          : "closed",
    title: pull.title,
    url: pull.url,
  };
  // GitHub lists reviews oldest first, so a later one replaces an earlier.
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    if (
      review.author &&
      review.state !== "COMMENTED" &&
      review.state !== "PENDING"
    ) {
      latest.set(review.author.login.toLowerCase(), review);
    }
  }
  const login = requesterLogin?.toLowerCase();
  const requesterReview = login ? latest.get(login) : undefined;
  state.requesterApproved = requesterReview?.state === "APPROVED";
  if (!open) return state;

  // A dismissed review counts only when it is the person's latest review.
  // GitHub keeps their earlier reviews, such as a comment before it.
  const latestSubmitted = new Map<string, string>();
  for (const review of reviews) {
    if (review.author && review.submittedAt && review.state !== "PENDING") {
      latestSubmitted.set(review.author.login.toLowerCase(), review.state);
    }
  }
  state.reviewedBy = [...latestSubmitted].flatMap(([login, reviewState]) =>
    reviewState === "DISMISSED" ? [] : [login],
  );
  const reviewStates = [...latest.values()].map((review) => review.state);
  if (reviewStates.includes("CHANGES_REQUESTED")) {
    state.reviewOutcome = "changesRequested";
  } else if (reviewStates.includes("APPROVED")) {
    state.reviewOutcome = "approved";
  }
  return state;
}
