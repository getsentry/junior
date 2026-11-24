/**
 * The kinds of Inbox items that the GitHub plugin adds. Junior stores each
 * one as `github:<kind>`. The subject id is GitHub's id of the pull request
 * (`databaseId`), which stays the same when the repository is renamed or
 * moved. It is also the provider id of the code change, so Junior reads the
 * link and the search title from the code change, and the title and state
 * from the pull request's card.
 */
import type {
  ObjectAnnotation,
  PluginInboxItemSubject,
  PluginInboxSubjectKind,
} from "@sentry/junior-plugin-api";

/** The subject kinds of GitHub Inbox items. */
export const GITHUB_INBOX_SUBJECTS = {
  mergeConflict: "merge_conflict",
  pullRequest: "pull_request",
} as const;

/**
 * Name the requester's ask on a Junior pull request from its live card. The
 * plugin keeps the item open only while there is an ask, and it is a merge
 * only after approval with no conflict.
 */
export function pullRequestAsk(object: ObjectAnnotation): string | undefined {
  const facts = object.facts;
  if (facts?.type !== "code_change") return undefined;
  return facts.review === "approved" && facts.mergeable !== false
    ? "Ready to merge"
    : "Review requested";
}

/** The registered kinds and labels, for the plugin registration. */
export const githubInboxSubjectKinds: PluginInboxSubjectKind[] = [
  {
    ask: pullRequestAsk,
    codeChange: true,
    kind: GITHUB_INBOX_SUBJECTS.pullRequest,
    label: "Pull request",
  },
  {
    codeChange: true,
    kind: GITHUB_INBOX_SUBJECTS.mergeConflict,
    label: "Merge conflict",
  },
];

/** The subject of an Inbox item about one pull request. */
export function pullRequestSubject(
  kind: (typeof GITHUB_INBOX_SUBJECTS)[keyof typeof GITHUB_INBOX_SUBJECTS],
  pullRequestId: string,
): PluginInboxItemSubject {
  return { id: pullRequestId, kind };
}
