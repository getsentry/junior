import type { PluginState } from "@sentry/junior-plugin-api";
import pLimit from "p-limit";

// GitHub sends one `review_requested` webhook per reviewer, and only one
// webhook at a time checks a pull request. A webhook that arrives during a
// check saves its reviewer here, so the running check can ask them. The
// mark only needs to outlive that check.
const REQUESTED_TTL_MS = 60 * 60 * 1000;
// State reads of one check that run at once.
const STATE_CALLS = 5;

interface PullRequestTarget {
  number: number;
  repositoryFullName: string;
}

function requestedKey(target: PullRequestTarget, login: string): string {
  return `pull-request-review-requested:${target.repositoryFullName.toLowerCase()}#${target.number}:${login.toLowerCase()}`;
}

/** Save a review request until a check of its pull request asks the reviewer. */
export async function markGitHubReviewRequested(
  state: PluginState,
  target: PullRequestTarget,
  login: string,
): Promise<void> {
  await state.set(requestedKey(target, login), true, REQUESTED_TTL_MS);
}

/** Return the lowercase logins among `logins` that have a saved request. */
export async function readGitHubReviewRequested(
  state: PluginState,
  target: PullRequestTarget,
  logins: readonly string[],
): Promise<string[]> {
  const saved = await pLimit(STATE_CALLS).map(logins, async (login) =>
    (await state.get(requestedKey(target, login))) === true
      ? [login.toLowerCase()]
      : [],
  );
  return saved.flat();
}

/** Drop the saved requests of reviewers that a check asked. */
export async function dropGitHubReviewRequested(
  state: PluginState,
  target: PullRequestTarget,
  logins: readonly string[],
): Promise<void> {
  await pLimit(STATE_CALLS).map(
    logins,
    async (login) => await state.delete(requestedKey(target, login)),
  );
}
