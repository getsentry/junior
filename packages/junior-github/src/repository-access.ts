/**
 * Whether a viewer's linked GitHub account can see a repository. Junior
 * reads with the App, so it asks GitHub about the viewer before it shows
 * them anything that the App read, such as a card or an image.
 */
import type {
  PluginCache,
  PluginEgress,
  PluginLogger,
  User,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { linkedGitHubLogin } from "./tool-support/attribution.js";
import { githubApi, repoPath } from "./tool-support/github-api.js";

// Access changes rarely. A removed collaborator can keep seeing objects this
// long, the same as the repository role of webhook handling.
const ACCESS_TTL_MS = 10 * 60 * 1000;
const permissionSchema = z.object({ permission: z.string().min(1) });

// A GitHub failure that is not an answer about access, such as a rate limit.
class AccessReadFailed extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub repository permission read failed with HTTP ${status}`);
    this.status = status;
  }
}

async function readRepositoryAccess(
  ctx: { cache: PluginCache; egress: PluginEgress },
  repository: { name: string; owner: string },
  login: string,
): Promise<boolean> {
  return await ctx.cache.getOrLoad(
    `repository-access:${repository.owner}/${repository.name}:${login}`.toLowerCase(),
    async () => {
      const response = await githubApi(ctx.egress, {
        operation: "github.repository.collaborator-permission.get",
        path: `${repoPath(repository)}/collaborators/${encodeURIComponent(login)}/permission`,
      });
      // GitHub answers 404 when the App cannot see the repository or does
      // not know the login. Other failures, such as a rate limit, are not
      // an answer, so they are not cached.
      if (!response.ok && response.status !== 404) {
        throw new AccessReadFailed(response.status);
      }
      const parsed = response.ok
        ? permissionSchema.safeParse(response.body)
        : undefined;
      return {
        value: parsed?.success === true && parsed.data.permission !== "none",
        ttlMs: ACCESS_TTL_MS,
      };
    },
  );
}

/**
 * Return whether the viewer's linked GitHub account can see the repository.
 * A viewer without a linked account, and a failed read, get false. A failed
 * read is not kept, so the next call asks GitHub again.
 */
export async function viewerCanSeeRepository(
  ctx: {
    cache: PluginCache;
    egress: PluginEgress;
    log: PluginLogger;
    viewer: User;
  },
  repository: { name: string; owner: string },
): Promise<boolean> {
  const login = linkedGitHubLogin(ctx.viewer);
  if (!login) return false;
  try {
    return await readRepositoryAccess(ctx, repository, login);
  } catch (error) {
    if (!(error instanceof AccessReadFailed)) throw error;
    ctx.log.warn("github.repository_access.read_failed", {
      "http.response.status_code": error.status,
    });
    return false;
  }
}
