/**
 * Description images of GitHub objects, served through the Junior image
 * route. Each read checks that the viewer's linked GitHub account can see
 * the repository. Only then does Junior fetch the image with the App.
 */
import {
  decodeObjectImageRef,
  type ImageFetch,
  type ImageSourceContext,
  type PluginImageSource,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubImageKind } from "./object-facts.js";
import { linkedGitHubLogin } from "./tool-support/attribution.js";
import {
  githubApi,
  githubAttachmentLocation,
  repoPath,
} from "./tool-support/github-api.js";

// Annotation keys of pull requests and issues: `owner/repo#number`.
const OBJECT_KEY = /^([\w.-]+)\/([\w.-]+)#\d+$/;
// Access changes rarely. A removed collaborator can keep seeing images this
// long, the same as the repository role of webhook handling.
const ACCESS_TTL_MS = 10 * 60 * 1000;
const permissionSchema = z.object({ permission: z.string().min(1) });

async function canSeeRepository(
  ctx: ImageSourceContext,
  repository: { name: string; owner: string },
  login: string,
): Promise<boolean> {
  return await ctx.cache.getOrLoad(
    `image-access:${repository.owner}/${repository.name}:${login}`.toLowerCase(),
    async () => {
      const response = await githubApi(ctx.egress, {
        operation: "github.repository.collaborator-permission.get",
        path: `${repoPath(repository)}/collaborators/${encodeURIComponent(login)}/permission`,
      });
      // GitHub answers 404 when the App cannot see the repository or does
      // not know the login. Other failures, such as a rate limit, are not
      // an answer, so they are not cached.
      if (!response.ok && response.status !== 404) {
        throw new Error(
          `GitHub repository permission read failed with HTTP ${response.status}`,
        );
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

/** Serve the description images of GitHub objects to viewers who can see the repository. */
export const githubImageSource: PluginImageSource = {
  async resolve(ctx, ref): Promise<ImageFetch | undefined> {
    const image = decodeObjectImageRef(ref);
    const key = image && OBJECT_KEY.exec(image.key);
    if (!image || !key || !URL.canParse(image.url)) return undefined;
    const kind = githubImageKind(new URL(image.url));
    const login = linkedGitHubLogin(ctx.viewer);
    if (!kind || !login) return undefined;
    const repository = { name: key[2]!, owner: key[1]! };
    if (!(await canSeeRepository(ctx, repository, login))) return undefined;
    return kind === "artifact"
      ? { url: image.url }
      : {
          url: image.url,
          location: () => githubAttachmentLocation(ctx.egress, image.url),
        };
  },
};
