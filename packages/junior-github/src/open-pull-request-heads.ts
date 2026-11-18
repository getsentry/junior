/**
 * Open pull request lookup for the Git push policy.
 *
 * GitHub closes an open pull request at once when a push leaves its head
 * branch with no commits ahead of its base. The egress grant hook decides
 * whether a push may leave the sandbox, so it cannot read GitHub through host
 * egress. This file calls GitHub directly, with a read-only installation
 * token.
 */
import type { PluginGitRefUpdate } from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import {
  GitHubRequestError,
  githubRequest,
  issueInstallationToken,
  type GitHubRepository,
} from "./credential-support.js";
import type { GitHubInstallationEnv } from "./webhooks/installation-requests.js";

const API_BASE = "https://api.github.com";
const BRANCH_PREFIX = "refs/heads/";
const LOOKUP_CONCURRENCY = 4;

const pullRequestsSchema = z.array(
  z.object({
    base: z.object({
      ref: z.string().min(1),
      repo: z.object({ full_name: z.string().min(1) }),
    }),
    head: z.object({
      // GitHub returns null when the head repository was deleted.
      repo: z.object({ full_name: z.string().min(1) }).nullable(),
    }),
    number: z.number().int().positive(),
  }),
);

const comparisonSchema = z.object({ ahead_by: z.number().int().nonnegative() });

/** An open pull request that a push would leave with no commits ahead of its base. */
export interface EmptiedPullRequest {
  base: string;
  branch: string;
  number: number;
}

function encodeBranch(branch: string): string {
  return encodeURIComponent(branch).replace(/%2F/g, "/");
}

/**
 * Find the open pull requests that a push would leave with no commits ahead
 * of their base. Pull requests from forks do not count: a push to this
 * repository cannot change a fork's branch.
 */
export async function findEmptiedPullRequests(
  env: GitHubInstallationEnv,
  repository: GitHubRepository,
  updates: PluginGitRefUpdate[],
): Promise<EmptiedPullRequest[]> {
  const pushes = updates.filter(
    (update) => !update.deletes && update.ref.startsWith(BRANCH_PREFIX),
  );
  if (pushes.length === 0) {
    return [];
  }
  const { owner, name } = repository;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const { token } = await issueInstallationToken({
    ...env,
    // Listing pull requests needs pull_requests; comparing commits needs contents.
    permissions: { contents: "read", pull_requests: "read" },
    repositories: [name],
  });
  const limit = pLimit(LOOKUP_CONCURRENCY);

  const candidates = (
    await limit.map(pushes, async (update) => {
      const branch = update.ref.slice(BRANCH_PREFIX.length);
      const query = new URLSearchParams({
        head: `${owner}:${branch}`,
        state: "open",
      });
      const pulls = pullRequestsSchema.parse(
        await githubRequest(API_BASE, `${repoPath}/pulls?${query}`, { token }),
      );
      return (
        pulls
          // A fork PR's head branch is in another repository.
          .filter(
            (pull) => pull.head.repo?.full_name === pull.base.repo.full_name,
          )
          .map((pull) => ({
            base: pull.base.ref,
            branch,
            newObjectId: update.newObjectId,
            number: pull.number,
          }))
      );
    })
  ).flat();

  const emptied = await limit.map(candidates, async (candidate) => {
    let comparison: unknown;
    try {
      comparison = await githubRequest(
        API_BASE,
        `${repoPath}/compare/${encodeBranch(candidate.base)}...${candidate.newObjectId}?per_page=1`,
        { token },
      );
    } catch (error) {
      // GitHub does not know the commit yet, so the push brings it. A new
      // commit cannot already be in the base.
      if (
        error instanceof GitHubRequestError &&
        (error.status === 404 || error.status === 422)
      ) {
        return undefined;
      }
      throw error;
    }
    if (comparisonSchema.parse(comparison).ahead_by > 0) {
      return undefined;
    }
    return {
      base: candidate.base,
      branch: candidate.branch,
      number: candidate.number,
    };
  });
  return emptied.filter((pull) => pull !== undefined);
}
