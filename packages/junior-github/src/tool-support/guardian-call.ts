import {
  PluginToolInputError,
  type GuardianContext,
  type GuardianResult,
} from "@sentry/junior-plugin-api";
import { repositoryAudience } from "../repository-audience.js";
import { parseRepo } from "./github-api.js";

/**
 * What a call on one repository, or on one issue or pull request in it,
 * touches, for Guardian. The audience is the repository's visibility.
 */
export async function repositoryCall(
  repoInput: string,
  ctx: GuardianContext,
  number?: number,
): Promise<GuardianResult> {
  const suffix = number === undefined ? "" : `#${number}`;
  let repo: ReturnType<typeof parseRepo>;
  try {
    repo = parseRepo(repoInput);
  } catch (error) {
    // The tool call itself reports a malformed repository.
    if (error instanceof PluginToolInputError) {
      return { target: `${repoInput}${suffix}`, audience: "world" };
    }
    throw error;
  }
  return {
    target: `${repo.ref}${suffix}`,
    audience: await repositoryAudience(ctx, repo),
  };
}

/**
 * What a call on one pull request touches, for Guardian. The call gets
 * `allow` only when it sets nothing but the fields in `textFields` on a pull
 * request that this work created, as core's code-change records say. Any
 * other field, such as a new state or a review request, changes what the
 * pull request waits on.
 */
export async function pullRequestCall(
  input: { repo: string; pull_request: number } & Record<string, unknown>,
  ctx: GuardianContext,
  textFields: readonly string[],
): Promise<GuardianResult> {
  const result = await repositoryCall(input.repo, ctx, input.pull_request);
  const allowed = new Set(["repo", "pull_request", ...textFields]);
  const textOnly = Object.entries(input).every(
    ([field, value]) => value === undefined || allowed.has(field),
  );
  const repo = result.target.slice(0, -`#${input.pull_request}`.length);
  if (!textOnly || !(await isOwnPullRequest(repo, input.pull_request, ctx))) {
    return result;
  }
  return {
    ...result,
    decision: "allow",
    reason: "own-pr-text",
  };
}

async function isOwnPullRequest(
  repo: string,
  number: number,
  ctx: GuardianContext,
): Promise<boolean> {
  const conversationIds = await ctx.conversationIds();
  if (conversationIds.length === 0) return false;
  const changes = await ctx.codeChanges.list({
    conversationIds,
    repository: { name: repo, numbers: [number] },
  });
  return changes.length > 0;
}
