/**
 * The kinds of Inbox items that the GitHub plugin adds. Junior stores each
 * one as `github:<kind>`. The kind says what the item asks, and its label
 * names that ask in the Inbox. The subject id is the canonical URL of the
 * pull request, and the card of that URL gives its title and state.
 */
import type { PluginInboxSubjectKind } from "@sentry/junior-plugin-api";

/** The subject kinds of GitHub Inbox items. */
export const GITHUB_INBOX_SUBJECTS = {
  mergeConflict: "merge_conflict",
  pullRequestMerge: "pull_request_merge",
  pullRequestReview: "pull_request_review",
} as const;

/** The registered kinds and labels, for the plugin registration. */
export const githubInboxSubjectKinds: PluginInboxSubjectKind[] = [
  { kind: GITHUB_INBOX_SUBJECTS.pullRequestReview, label: "Review requested" },
  { kind: GITHUB_INBOX_SUBJECTS.pullRequestMerge, label: "Ready to merge" },
  { kind: GITHUB_INBOX_SUBJECTS.mergeConflict, label: "Merge conflict" },
];
