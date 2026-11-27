import {
  PluginToolInputError,
  type CallDescription,
  type DescribeContext,
} from "@sentry/junior-plugin-api";
import { parseRepo } from "./github-api.js";

/**
 * What a call on one pull request touches, for Guardian. Junior stores no
 * visibility for a repository, so the audience is `world`. The call gets
 * `allow` advice only when it changes just the text of a pull request that
 * this work created, as core's code-change records say.
 */
export async function describePullRequestCall(
  repoInput: string,
  number: number,
  ctx: DescribeContext,
  textOnly: boolean,
): Promise<CallDescription> {
  let repo: string;
  try {
    repo = parseRepo(repoInput).ref;
  } catch (error) {
    // The tool call itself reports a malformed repository.
    if (error instanceof PluginToolInputError) {
      return { ref: `${repoInput}#${number}`, audience: "world" };
    }
    throw error;
  }
  const ref = `${repo}#${number}`;
  if (!textOnly || !(await ctx.isOwnPullRequest(repo, number))) {
    return { ref, audience: "world" };
  }
  return {
    ref,
    audience: "world",
    advice: "allow",
    reason: `Only the text of ${ref}, which this work created, changes.`,
  };
}
