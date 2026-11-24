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
  PluginInboxViewer,
} from "@sentry/junior-plugin-api";

/** The subject kind of the Inbox item of a Junior pull request. */
export const PULL_REQUEST_SUBJECT_KIND = "pull_request";

/**
 * Name the viewer's ask on a Junior pull request from its live card. A
 * reviewer whose review GitHub requests reviews it. The requester merges it
 * after approval, or resumes the fix of a conflict.
 */
export function pullRequestAsk(
  object: ObjectAnnotation,
  viewer: PluginInboxViewer,
): string | undefined {
  const facts = object.facts;
  if (facts?.type !== "code_change") return undefined;
  const handle = viewer.handle?.toLowerCase();
  if (
    handle &&
    facts.reviewers?.some((reviewer) => reviewer.toLowerCase() === handle)
  ) {
    return "Review requested";
  }
  if (facts.mergeable === false) return "Merge conflict";
  return facts.review === "approved" ? "Ready to merge" : "Review requested";
}

/** The registered kinds and labels, for the plugin registration. */
export const githubInboxSubjectKinds: PluginInboxSubjectKind[] = [
  {
    ask: pullRequestAsk,
    codeChange: true,
    kind: PULL_REQUEST_SUBJECT_KIND,
    label: "Pull request",
  },
];

/** The subject of the Inbox item of one pull request. */
export function pullRequestSubject(
  pullRequestId: string,
): PluginInboxItemSubject {
  return { id: pullRequestId, kind: PULL_REQUEST_SUBJECT_KIND };
}
