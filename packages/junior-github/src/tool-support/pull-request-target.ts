import {
  PluginToolInputError,
  type ActionTarget,
} from "@sentry/junior-plugin-api";
import { parseRepo } from "./github-api.js";

/**
 * The pull request that a call changes, for Guardian. Core tells whether
 * this work created it from its code-change records, which hold only pull
 * requests that the bot authored. Junior stores no visibility for a
 * repository, so the audience is `world`.
 */
export function pullRequestTarget(
  repoInput: string,
  number: number,
): ActionTarget | undefined {
  let repo: string;
  try {
    repo = parseRepo(repoInput).ref;
  } catch (error) {
    // The tool call itself reports a malformed repository.
    if (error instanceof PluginToolInputError) return undefined;
    throw error;
  }
  return {
    ref: `${repo}#${number}`,
    audience: "world",
    codeChange: { repository: repo, number },
  };
}
