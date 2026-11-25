/**
 * The kinds of Inbox items that the GitHub plugin adds. Junior stores each
 * one as `github:<kind>`. The subject id is GitHub's id of the pull request
 * or issue (`databaseId`), which stays the same when the repository is
 * renamed or moved. A pull request's id is also the provider id of the code
 * change, so Junior reads the link and the search title from the code
 * change, and the title and state from the pull request's card.
 */
import type {
  ObjectAnnotation,
  PluginInboxItemSubject,
  PluginInboxSubjectKind,
  PluginInboxSubjectOwner,
} from "@sentry/junior-plugin-api";

/** The subject kinds of GitHub Inbox items. */
export const GITHUB_INBOX_SUBJECTS = {
  issue: "issue",
  mergeConflict: "merge_conflict",
  pullRequest: "pull_request",
} as const;

/**
 * Name the ask on a Junior pull request from its live card. Once it is
 * approved, GitHub reports that it can merge, and it is no draft, the ask
 * is the merge for every viewer, also a reviewer whose review GitHub still
 * requests. Before that, it is the review. A conflict has its own item.
 */
export function pullRequestAsk(object: ObjectAnnotation): string | undefined {
  const facts = object.facts;
  if (facts?.type !== "code_change") return undefined;
  return facts.review === "approved" &&
    facts.mergeable === true &&
    object.status !== "draft"
    ? "Ready to merge"
    : "Review requested";
}

// Both kinds use GitHub's pull request id as the subject id. The item
// belongs to the Conversation where a person asked Junior to open the pull
// request: only that opener row has both columns set.
const pullRequestOwner: PluginInboxSubjectOwner = {
  conversationId: "conversation_id",
  subjectId: "pull_request_id",
  table: "junior_github_pull_request_requesters",
};

/** The registered kinds and labels, for the plugin registration. */
export const githubInboxSubjectKinds: PluginInboxSubjectKind[] = [
  // A requested reviewer with a linked account is on the item, also from
  // outside the Conversation. A dismiss removes only the person who
  // dismissed it, and removes them from the requested reviewers when GitHub
  // lists them there.
  {
    ask: pullRequestAsk,
    codeChange: true,
    assigneeRoles: true,
    kind: GITHUB_INBOX_SUBJECTS.pullRequest,
    label: "Pull request",
    owner: pullRequestOwner,
  },
  {
    codeChange: true,
    kind: GITHUB_INBOX_SUBJECTS.mergeConflict,
    label: "Merge conflict",
    owner: pullRequestOwner,
  },
  // An issue that Junior created, for its assignees. It belongs to the
  // Conversation that created the issue: the first to save its card. A
  // dismiss unassigns only the person who dismissed it.
  {
    assigneeRoles: true,
    kind: GITHUB_INBOX_SUBJECTS.issue,
    label: "Issue",
    owner: "annotation",
  },
];

/** The subject of the Inbox item of one issue that Junior created. */
export function issueSubject(issueId: string): PluginInboxItemSubject {
  return { id: issueId, kind: GITHUB_INBOX_SUBJECTS.issue };
}

/** The subject of an Inbox item about one pull request. */
export function pullRequestSubject(
  kind: (typeof GITHUB_INBOX_SUBJECTS)[keyof typeof GITHUB_INBOX_SUBJECTS],
  pullRequestId: string,
): PluginInboxItemSubject {
  return { id: pullRequestId, kind };
}
