/**
 * GitHub requests that webhook handling makes with installation tokens.
 *
 * A webhook delivery has no Turn and no egress context, so these requests
 * call GitHub directly. Other plugin code must use host egress.
 */
import type { PluginCache } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  githubRequest,
  issueInstallationToken,
} from "../credential-support.js";
import {
  pullRequestCommentReactionsPath,
  pullRequestFeedbackReactionContent,
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

/** Add the "reviewing" reaction to one pull request feedback comment. */
export async function markPullRequestFeedbackReviewing(
  env: GitHubInstallationEnv,
  target: {
    commentId: number;
    commentKind: "conversation" | "review";
    repo: string;
  },
): Promise<void> {
  const { owner, name } = splitRepository(target.repo, "pull request feedback");
  const token = await issueInstallationToken({
    ...env,
    repositories: [name],
  });
  await githubRequest(
    "https://api.github.com",
    pullRequestCommentReactionsPath({
      owner,
      name,
      commentKind: target.commentKind,
      commentId: target.commentId,
    }),
    {
      body: { content: pullRequestFeedbackReactionContent("reviewing") },
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
  draft: z.boolean().optional(),
  head: z.object({ sha: z.string().min(1) }),
  html_url: z.string().url(),
  merged: z.boolean(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
});

const reviewsSchema = z.array(
  z.object({
    state: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({ conclusion: z.string().nullable(), status: z.string() }),
  ),
  total_count: z.number(),
});

const PASSING_CHECK_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

/** The pull request facts that decide whether it is ready to merge. */
export interface GitHubPullRequestMergeState {
  /** At least one approval, and no reviewer still requests changes. */
  approved: boolean;
  /** The head commit has check runs, and every one finished and passed. */
  checksPassed: boolean;
  draft: boolean;
  state: "closed" | "merged" | "open";
  title: string;
  url: string;
}

/**
 * Read whether a pull request is ready to merge, with a read-only token.
 * Reviews and checks load only for an open pull request that is not a draft.
 * Each reviewer counts by their latest approval, change request, or
 * dismissal. Comments do not change the result.
 */
export async function loadPullRequestMergeState(
  env: GitHubInstallationEnv,
  pullRequest: { number: number; repositoryFullName: string },
): Promise<GitHubPullRequestMergeState> {
  const { owner, name } = splitRepository(
    pullRequest.repositoryFullName,
    "pull request merge state",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { checks: "read", pull_requests: "read" },
    repositories: [name],
  });
  const read = async (path: string) =>
    await githubRequest(
      "https://api.github.com",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`,
      { token: token.token },
    );
  const pull = pullRequestSchema.parse(
    await read(`/pulls/${pullRequest.number}`),
  );
  const state: GitHubPullRequestMergeState = {
    approved: false,
    checksPassed: false,
    draft: pull.draft === true,
    state: pull.merged ? "merged" : pull.state,
    title: pull.title,
    url: pull.html_url,
  };
  if (state.state !== "open" || state.draft) return state;

  const reviews = reviewsSchema.parse(
    await read(`/pulls/${pullRequest.number}/reviews?per_page=100`),
  );
  // A later page can hold a newer change request, so a full page does not pass.
  if (reviews.length >= 100) return state;
  const latestReviews = new Map<string, string>();
  for (const review of reviews) {
    if (
      review.user &&
      review.state !== "COMMENTED" &&
      review.state !== "PENDING"
    ) {
      latestReviews.set(review.user.login.toLowerCase(), review.state);
    }
  }
  const reviewStates = [...latestReviews.values()];
  state.approved =
    reviewStates.includes("APPROVED") &&
    !reviewStates.includes("CHANGES_REQUESTED");
  if (!state.approved) return state;

  const checks = checkRunsSchema.parse(
    await read(
      `/commits/${encodeURIComponent(pull.head.sha)}/check-runs?filter=latest&per_page=100`,
    ),
  );
  // A run past the first page could fail, so a partial list does not pass.
  state.checksPassed =
    checks.total_count > 0 &&
    checks.total_count === checks.check_runs.length &&
    checks.check_runs.every(
      (run) =>
        run.status === "completed" &&
        PASSING_CHECK_CONCLUSIONS.has(run.conclusion ?? ""),
    );
  return state;
}
