import { repoPath } from "./tool-support/github-api.js";

/**
 * GitHub has reactions but no feedback state. `updatePullRequestFeedback` maps
 * each state to a reaction and keeps at most one state reaction that Junior
 * owns. It does not change reactions from other users.
 */
const STATUS_TO_REACTION_CONTENT = {
  reviewing: "eyes",
  addressed: "+1",
  declined: "-1",
} as const;
/** Every reaction that marks a feedback state. */
export const FEEDBACK_REACTION_CONTENTS = new Set<string>(
  Object.values(STATUS_TO_REACTION_CONTENT),
);
/** Feedback state of one pull request comment. */
export type FeedbackStatus = keyof typeof STATUS_TO_REACTION_CONTENT;
type PullRequestCommentKind = "conversation" | "review";

// A review body has no REST reactions endpoint, so it uses GraphQL, which
// names the same reactions differently.
const GRAPHQL_REACTION_CONTENT: Record<string, string> = {
  eyes: "EYES",
  "+1": "THUMBS_UP",
  "-1": "THUMBS_DOWN",
};
/** REST name of each GraphQL reaction content. */
export const REST_REACTION_CONTENT = new Map(
  Object.entries(GRAPHQL_REACTION_CONTENT).map(([rest, graphql]) => [
    graphql,
    rest,
  ]),
);

/** One pull request comment in a repository. */
export interface PullRequestCommentRef {
  owner: string;
  name: string;
  commentKind: PullRequestCommentKind;
  commentId: number;
}

/** Build the GitHub API path for one pull request comment. */
export function pullRequestCommentPath(input: PullRequestCommentRef): string {
  // Conversation comments live under the issues endpoint; inline review
  // comments live under the pulls endpoint. GitHub has no shared path.
  const segment = input.commentKind === "conversation" ? "issues" : "pulls";
  return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/${segment}/comments/${input.commentId}`;
}

/** Build the GitHub API path for one pull request comment's reactions. */
export function pullRequestCommentReactionsPath(
  input: PullRequestCommentRef,
): string {
  return `${pullRequestCommentPath(input)}/reactions`;
}

/** Return the GitHub reaction for one feedback state. */
export function pullRequestFeedbackReactionContent(
  status: FeedbackStatus,
): (typeof STATUS_TO_REACTION_CONTENT)[FeedbackStatus] {
  return STATUS_TO_REACTION_CONTENT[status];
}

/** Build the GitHub API path for one pull request review. */
export function pullRequestReviewPath(input: {
  owner: string;
  name: string;
  pullRequest: number;
  reviewId: number;
}): string {
  return `${repoPath(input)}/pulls/${input.pullRequest}/reviews/${input.reviewId}`;
}

/** Return the GraphQL name of one REST reaction content. */
export function graphqlReactionContent(content: string): string {
  return GRAPHQL_REACTION_CONTENT[content] ?? content;
}
