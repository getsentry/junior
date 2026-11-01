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
  html_url: z.string().url(),
  mergeable_state: z.string().nullable().optional(),
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

/** The pull request facts that decide whether it is ready to merge. */
export interface GitHubPullRequestMergeState {
  /**
   * At least one approval, and no reviewer still requests changes. Read
   * only when GitHub says the pull request can merge cleanly.
   */
  approved: boolean;
  draft: boolean;
  /**
   * GitHub's `mergeable_state`, such as `clean` or `blocked`. `clean` means
   * that the required reviews and every check and status passed, and there
   * are no conflicts. Undefined when GitHub has not computed it yet.
   */
  mergeableState?: string;
  state: "closed" | "merged" | "open";
  title: string;
  url: string;
}

/**
 * Read whether a pull request is ready to merge, with a read-only token.
 * GitHub computes `mergeable_state` after a change, so an unknown state is
 * read once more. Reviews load only for an open pull request that is not a
 * draft and can merge cleanly. Each reviewer counts by their latest
 * approval, change request, or dismissal. Comments do not change the result.
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
      draft: pull.draft === true,
      ...(mergeableState ? { mergeableState } : undefined),
      state: pull.merged ? ("merged" as const) : pull.state,
      title: pull.title,
      url: pull.html_url,
    };
  };
  let state: GitHubPullRequestMergeState = await readPull();
  if (state.state !== "open" || state.draft) return state;
  if (!state.mergeableState) state = await readPull();
  if (state.mergeableState !== "clean") return state;

  // A later page can hold a newer review, so read every page. GitHub lists
  // reviews oldest first.
  const reviews: z.infer<typeof reviewsSchema> = [];
  for (let page = 1; ; page++) {
    const batch = reviewsSchema.parse(
      await read(`/reviews?per_page=100&page=${page}`),
    );
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
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
  return state;
}
