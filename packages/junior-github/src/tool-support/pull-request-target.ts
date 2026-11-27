import {
  PluginToolInputError,
  type ToolCallContext,
  type ToolCallTarget,
} from "@sentry/junior-plugin-api";
import { parseRepo } from "./github-api.js";

/**
 * The pull request that a call changes, for Guardian. This work created it
 * when Junior's code records link it to this Conversation, an ancestor, or
 * a descendant. Only the GitHub plugin records a code change, and only for
 * a pull request that the bot authored, so a pull request that a person
 * opened, or that only an annotation names, never counts. Junior stores no
 * visibility for a repository, so the audience is `world`.
 */
export async function pullRequestTarget(
  repoInput: string,
  number: number,
  ctx: ToolCallContext,
): Promise<ToolCallTarget | undefined> {
  let repo: string;
  try {
    repo = parseRepo(repoInput).ref;
  } catch (error) {
    // The tool call itself reports a malformed repository.
    if (error instanceof PluginToolInputError) return undefined;
    throw error;
  }
  const [change] = await ctx.codeChanges.list({
    conversationIds: await ctx.conversationIds(),
    repository: { name: repo, numbers: [number] },
  });
  return {
    ref: `${repo}#${number}`,
    audience: "world",
    createdByThisWork: change !== undefined,
  };
}
