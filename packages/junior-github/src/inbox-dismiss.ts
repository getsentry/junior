/**
 * A dismiss of a GitHub item removes the person on GitHub too, so GitHub
 * stays the source of truth: the webhook that follows changes the item for
 * everyone else. Core removes the person from the item after this succeeds,
 * and a GitHub refusal fails the dismiss.
 */
import type { InboxItemDismissedHookContext } from "@sentry/junior-plugin-api";
import { GITHUB_INBOX_SUBJECTS } from "./inbox-subjects.js";
import {
  removeIssueAssignees,
  removeRequestedReviewer,
  type GitHubInstallationEnv,
} from "./webhooks/installation-requests.js";

/** Split an Annotation key, such as `getsentry/junior#12`. */
function parseObjectKey(
  key: string,
): { number: number; repositoryFullName: string } | undefined {
  const match = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(key);
  return match
    ? { number: Number(match[2]), repositoryFullName: match[1]! }
    : undefined;
}

/** Unassign the person who dismissed an issue item from the issue. */
async function unassignFromIssue(
  ctx: InboxItemDismissedHookContext,
  env: GitHubInstallationEnv,
  login: string,
): Promise<void> {
  // The owner Conversation saved the issue's card when it created it. The
  // card's key holds the name of the issue then. GitHub answers a renamed
  // repository's old name with a redirect.
  const card = (await ctx.annotations.list()).find(
    (annotation) =>
      annotation.kind === "object" &&
      annotation.subject?.kind === ctx.subject.kind &&
      annotation.subject.id === ctx.subject.id,
  );
  const ref = card ? parseObjectKey(card.key) : undefined;
  if (!ref) {
    throw new Error(
      `GitHub issue ${ctx.subject.id} has no card in Conversation ${ctx.conversationId}`,
    );
  }
  await removeIssueAssignees(env, { ...ref, assignees: [login] });
}

/**
 * Remove the person who dismissed a pull request item from its requested
 * reviewers. A requester, such as on Ready to merge, holds no reviewer role,
 * so their dismiss changes nothing on GitHub.
 */
async function removeFromReviewers(
  ctx: InboxItemDismissedHookContext,
  env: GitHubInstallationEnv,
): Promise<void> {
  if (!ctx.handle) return;
  const [change] = await ctx.codeChanges.list({
    providerIds: [ctx.subject.id],
  });
  if (!change) {
    throw new Error(`GitHub pull request ${ctx.subject.id} has no code change`);
  }
  await removeRequestedReviewer(env, {
    login: ctx.handle,
    number: change.number,
    repositoryFullName: change.repository.name,
  });
}

/** Remove the person who dismissed a GitHub item from the object on GitHub. */
export async function dismissGitHubItem(
  ctx: InboxItemDismissedHookContext,
  env: GitHubInstallationEnv,
): Promise<void> {
  if (ctx.subject.kind === GITHUB_INBOX_SUBJECTS.pullRequest) {
    await removeFromReviewers(ctx, env);
    return;
  }
  if (ctx.subject.kind !== GITHUB_INBOX_SUBJECTS.issue) return;
  // A person is on an issue item only through their linked login.
  if (!ctx.handle) {
    throw new Error("The person who dismissed has no linked GitHub account");
  }
  await unassignFromIssue(ctx, env, ctx.handle);
}
