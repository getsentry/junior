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
  type GitHubAppEnv,
} from "../credential-support.js";
import {
  pullRequestCommentReactionsPath,
  pullRequestFeedbackReactionContent,
} from "../tools/update-pull-request-feedback.js";

function splitRepository(fullName: string, label: string) {
  const [owner, name, ...extra] = fullName.split("/");
  if (!owner || !name || extra.length > 0) {
    throw new Error(`GitHub ${label} received an invalid repository name`);
  }
  return { owner, name };
}

/** Return a reader for pages of a pull request's commits, with a read-only token. */
export async function loadPullRequestCommitPages(
  app: GitHubAppEnv,
  pullRequest: {
    installationId: number;
    number: number;
    repositoryFullName: string;
  },
): Promise<(page: number, perPage: number) => Promise<unknown>> {
  const { owner, name } = splitRepository(
    pullRequest.repositoryFullName,
    "pull request commits",
  );
  const token = await issueInstallationToken({
    ...app,
    installationId: pullRequest.installationId,
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
  app: GitHubAppEnv,
  target: {
    commentId: number;
    commentKind: "conversation" | "review";
    installationId: number;
    repo: string;
  },
): Promise<void> {
  const { owner, name } = splitRepository(target.repo, "pull request feedback");
  const token = await issueInstallationToken({
    ...app,
    installationId: target.installationId,
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
  app: GitHubAppEnv,
  cache: PluginCache,
  target: { installationId: number; login: string; repositoryFullName: string },
): Promise<string> {
  const { owner, name } = splitRepository(
    target.repositoryFullName,
    "repository role",
  );
  return await cache.getOrLoad(
    `repository-role:${owner}/${name}:${target.login}`.toLowerCase(),
    async () => {
      const token = await issueInstallationToken({
        ...app,
        installationId: target.installationId,
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
