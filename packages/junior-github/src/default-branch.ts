/**
 * Default branch lookup for the Git push policy.
 *
 * The egress grant hook decides whether a push may leave the sandbox, so it
 * cannot read GitHub through host egress. This file calls GitHub directly,
 * with a metadata-only installation token.
 */
import type { PluginCache } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  githubRequest,
  issueInstallationToken,
  type GitHubRepository,
} from "./credential-support.js";
import type { GitHubInstallationEnv } from "./webhooks/installation-requests.js";

// Default branches change rarely. A rename takes effect within this window.
const DEFAULT_BRANCH_TTL_MS = 10 * 60 * 1000;

const repositorySchema = z.object({ default_branch: z.string().min(1) });

/**
 * Read a repository's default branch with a metadata-only installation
 * token. Results are cached for ten minutes.
 */
export async function loadDefaultBranch(
  env: GitHubInstallationEnv,
  cache: PluginCache,
  repository: GitHubRepository,
): Promise<string> {
  const { owner, name } = repository;
  return await cache.getOrLoad(
    `default-branch:${owner}/${name}`.toLowerCase(),
    async () => {
      const token = await issueInstallationToken({
        ...env,
        permissions: { metadata: "read" },
        repositories: [name],
      });
      const response = repositorySchema.parse(
        await githubRequest(
          "https://api.github.com",
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
          { token: token.token },
        ),
      );
      return { value: response.default_branch, ttlMs: DEFAULT_BRANCH_TTL_MS };
    },
  );
}
