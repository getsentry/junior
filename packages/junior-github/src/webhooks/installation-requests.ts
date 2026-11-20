/**
 * GitHub requests that webhook handling makes with installation tokens.
 *
 * A webhook delivery has no Turn and no egress context, so these requests
 * call GitHub directly. Other plugin code must use host egress.
 */
import type { PluginCache } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GitHubRequestError,
  githubRequest,
  issueInstallationToken,
} from "../credential-support.js";
import {
  ADD_REVIEW_REACTION,
  OPEN_PULL_REQUEST_MERGEABILITY,
  PULL_REQUEST_CONFLICT_HISTORY,
  pullRequestLifecycles,
} from "../graphql-documents.js";
import { loadLatestReviews } from "../pull-request-reviews.js";
import { githubErrorMessage } from "../tool-support/github-api.js";
import {
  graphqlReactionContent,
  pullRequestCommentReactionsPath,
  pullRequestFeedbackReactionContent,
  pullRequestReviewPath,
} from "../tools/update-pull-request-feedback.js";

/** Environment variable names for the GitHub App installation. */
export interface GitHubInstallationEnv {
  appIdEnv: string;
  installationIdEnv: string;
  privateKeyEnv: string;
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
      { token: token.token },
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
    { token: token.token },
  );
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
  return await githubRequest("https://api.github.com", "/graphql", {
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
    method: "POST",
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
  return await githubRequest("https://api.github.com", "/graphql", {
    body: {
      ...OPEN_PULL_REQUEST_MERGEABILITY,
      variables: {
        after: input.after ?? null,
        query: `repo:${input.repositoryFullName} is:pr is:open author:${input.author}`,
      },
    },
    method: "POST",
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
  return await githubRequest("https://api.github.com", "/graphql", {
    body: {
      ...PULL_REQUEST_CONFLICT_HISTORY,
      variables: { name, number: pullRequest.number, owner },
    },
    method: "POST",
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

/**
 * Read one user's role on a repository, with a metadata-only token. GitHub
 * returns "none" for accounts without access, such as most bots. Roles are
 * cached for ten minutes.
 */
export async function loadRepositoryRole(
  env: GitHubInstallationEnv,
  cache: PluginCache,
  target: { login: string; repositoryFullName: string },
): Promise<string> {
  const { owner, name } = splitRepository(
    target.repositoryFullName,
    "repository role",
  );
  return await cache.getOrLoad(
    `repository-role:${owner}/${name}:${target.login}`.toLowerCase(),
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
          { token: token.token },
        ),
      );
      // role_name includes maintain, triage, and custom roles; permission does not.
      return {
        value: response.role_name?.trim() || response.permission,
        ttlMs: REPOSITORY_ROLE_TTL_MS,
      };
    },
  );
}

const pullRequestSchema = z.object({
  auto_merge: z.object({}).nullable().optional(),
  draft: z.boolean().optional(),
  head: z.object({ sha: z.string().min(1) }),
  html_url: z.string().url(),
  mergeable_state: z.string().nullable().optional(),
  merged: z.boolean(),
  // The people whose review is still requested. Teams are listed apart.
  requested_reviewers: z
    .array(z.object({ login: z.string().min(1) }))
    .optional(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
});

/** The pull request facts that decide its next action. */
export interface GitHubPullRequestMergeState {
  /**
   * At least one approval, and no reviewer still requests changes. Read
   * only when GitHub says the pull request can merge cleanly.
   */
  approved: boolean;
  /** A person turned on auto-merge, so GitHub merges it without them. */
  autoMerge: boolean;
  /**
   * The commit of the requester's latest change request, when that is their
   * latest review. Read only when the pull request is open, not a draft, and
   * GitHub does not ask the requester for a review, the requester acted
   * last, or it can merge cleanly.
   */
  changesRequestedCommit?: string;
  /** When the requester submitted that change request, if GitHub says. */
  changesRequestedAt?: Date;
  draft: boolean;
  /** The commit at the head of the pull request. */
  headSha: string;
  /**
   * GitHub's `mergeable_state`, such as `clean` or `blocked`. `clean` means
   * that the required reviews and every check and status passed, and there
   * are no conflicts. Undefined when GitHub has not computed it yet.
   */
  mergeableState?: string;
  /** Logins of the people whose review GitHub still requests. */
  requestedReviewers: string[];
  state: "closed" | "merged" | "open";
  title: string;
  url: string;
}

/**
 * Read whether a pull request is ready to merge, and whether the requester
 * changed their review, with a read-only token. GitHub computes
 * `mergeable_state` after a change, so an unknown state is read once more.
 * Reviews load for an open pull request that is not a draft, when it can
 * merge cleanly, when GitHub does not ask the requester for a review, or
 * when `requesterActedLast` says that their reply can end the review. Each
 * reviewer counts by their latest approval, change request, or dismissal.
 * Comments do not change the result.
 */
export async function loadPullRequestMergeState(
  env: GitHubInstallationEnv,
  pullRequest: { number: number; repositoryFullName: string },
  requester: { login: string | undefined; requesterActedLast: boolean },
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
  const read = async (path: string) =>
    await githubRequest(
      "https://api.github.com",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest.number}${path}`,
      { token: token.token },
    );
  const readPull = async () => {
    const pull = pullRequestSchema.parse(await read(""));
    const mergeableState =
      pull.mergeable_state && pull.mergeable_state !== "unknown"
        ? pull.mergeable_state
        : undefined;
    return {
      approved: false,
      autoMerge: Boolean(pull.auto_merge),
      draft: pull.draft === true,
      headSha: pull.head.sha,
      ...(mergeableState ? { mergeableState } : undefined),
      requestedReviewers: (pull.requested_reviewers ?? []).map(
        (reviewer) => reviewer.login,
      ),
      state: pull.merged ? ("merged" as const) : pull.state,
      title: pull.title,
      url: pull.html_url,
    };
  };
  let state: GitHubPullRequestMergeState = await readPull();
  if (state.state !== "open" || state.draft) return state;
  const canMerge = !state.autoMerge;
  if (canMerge && !state.mergeableState) state = await readPull();
  const login = requester.login?.toLowerCase();
  // GitHub stops asking a reviewer once they review. After a change request,
  // the requester's review is still wanted when Junior acts after it. A
  // GitHub request stays after the requester replies, so their reply can
  // end it only when the reviews show the change request.
  const readsChanges =
    login !== undefined &&
    (requester.requesterActedLast ||
      !state.requestedReviewers.some(
        (reviewer) => reviewer.toLowerCase() === login,
      ));
  const readsApproval = canMerge && state.mergeableState === "clean";
  if (!readsApproval && !readsChanges) return state;

  const latestReviews = await loadLatestReviews(
    async (query) => await read(`/reviews?${query}`),
  );
  const reviewStates = [...latestReviews.values()].map(
    (review) => review.state,
  );
  if (readsApproval) {
    state.approved =
      reviewStates.includes("APPROVED") &&
      !reviewStates.includes("CHANGES_REQUESTED");
  }
  const requesterReview = login ? latestReviews.get(login) : undefined;
  if (
    requesterReview?.state === "CHANGES_REQUESTED" &&
    requesterReview.commit_id
  ) {
    state.changesRequestedCommit = requesterReview.commit_id;
    if (requesterReview.submitted_at) {
      state.changesRequestedAt = new Date(requesterReview.submitted_at);
    }
  }
  return state;
}
