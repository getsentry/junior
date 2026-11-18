/**
 * The reviewers that a person named for a draft pull request.
 *
 * Junior asks for a review when it opens a pull request. A draft gets no
 * request, so GitHub does not notify the reviewers before the work is ready.
 * When the person named the reviewers, Junior saves them here, and the
 * `ready_for_review` webhook asks them. With no saved reviewers, that webhook
 * asks the requester.
 */
import type { PluginState } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubPullRequestTarget } from "../webhooks/pull-request-people.js";

// Junior drafts become ready within days. After this time, the request goes
// to the requester.
const DRAFT_REVIEWERS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const reviewersSchema = z.array(z.string().min(1)).min(1);

function draftReviewersKey(target: GitHubPullRequestTarget): string {
  return `pull-request-draft-reviewers:${target.repositoryFullName.toLowerCase()}#${target.number}`;
}

/** Save the reviewers that a person named for a draft pull request. */
export async function saveGitHubDraftReviewers(
  state: PluginState,
  target: GitHubPullRequestTarget,
  reviewers: string[],
): Promise<void> {
  await state.set(
    draftReviewersKey(target),
    reviewersSchema.parse(reviewers),
    DRAFT_REVIEWERS_TTL_MS,
  );
}

/** Return the reviewers that a person named for a draft pull request. */
export async function readGitHubDraftReviewers(
  state: PluginState,
  target: GitHubPullRequestTarget,
): Promise<string[] | undefined> {
  const saved = await state.get(draftReviewersKey(target));
  return saved === undefined ? undefined : reviewersSchema.parse(saved);
}
