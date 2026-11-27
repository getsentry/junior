import {
  PluginToolInputError,
  type CallDescription,
  type DescribeContext,
  type DescribeReadContext,
} from "@sentry/junior-plugin-api";
import { repositoryAudience } from "../repository-audience.js";
import { parseRepo } from "./github-api.js";

/**
 * What a call on one repository, or on one issue or pull request in it,
 * touches, for Guardian. The audience is the repository's visibility.
 */
export async function describeRepositoryCall(
  repoInput: string,
  ctx: DescribeReadContext,
  number?: number,
): Promise<CallDescription> {
  const suffix = number === undefined ? "" : `#${number}`;
  let repo: ReturnType<typeof parseRepo>;
  try {
    repo = parseRepo(repoInput);
  } catch (error) {
    // The tool call itself reports a malformed repository.
    if (error instanceof PluginToolInputError) {
      return { ref: `${repoInput}${suffix}`, audience: "world" };
    }
    throw error;
  }
  return {
    ref: `${repo.ref}${suffix}`,
    audience: await repositoryAudience(ctx, repo),
  };
}

/**
 * What a call on one pull request touches, for Guardian. The call gets
 * `allow` advice only when it changes just the text of a pull request that
 * this work created, as core's code-change records say.
 */
export async function describePullRequestCall(
  repoInput: string,
  number: number,
  ctx: DescribeContext,
  textOnly: boolean,
): Promise<CallDescription> {
  const described = await describeRepositoryCall(repoInput, ctx, number);
  const repo = described.ref.slice(0, -`#${number}`.length);
  if (!textOnly || !(await ctx.isOwnPullRequest(repo, number))) {
    return described;
  }
  return {
    ...described,
    advice: "allow",
    reason: `Only the text of ${described.ref}, which this work created, changes.`,
  };
}
