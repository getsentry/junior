/**
 * Who can read a GitHub repository, for Guardian: `internal` for a private
 * or internal repository, `world` for a public one. Junior reads it from
 * GitHub through the plugin cache, never from a tool's input or result.
 */
import type { Audience, DescribeReadContext } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubApi, repoPath } from "./tool-support/github-api.js";

// Visibility changes rarely. A change takes effect within this window.
const VISIBILITY_TTL_MS = 10 * 60 * 1000;

const repositorySchema = z.object({
  private: z.boolean(),
  visibility: z.string().optional(),
});

/**
 * The audience of one `owner/name` repository. When GitHub does not answer,
 * the audience is `world`, as for any target that Junior cannot type.
 */
export async function repositoryAudience(
  ctx: DescribeReadContext,
  repository: { name: string; owner: string },
): Promise<Audience> {
  try {
    return await ctx.cache.getOrLoad(
      `repository-audience:${repository.owner}/${repository.name}`.toLowerCase(),
      async () => {
        const response = await githubApi(ctx.egress, {
          operation: "github.repository.get",
          path: repoPath(repository),
        });
        // A failed read is not an answer, so it is not cached.
        if (!response.ok) {
          throw new Error(
            `GitHub repository read failed with HTTP ${response.status}`,
          );
        }
        const repo = repositorySchema.parse(response.body);
        const audience: Audience =
          repo.private || repo.visibility === "internal" ? "internal" : "world";
        return { value: audience, ttlMs: VISIBILITY_TTL_MS };
      },
    );
  } catch {
    return "world";
  }
}
