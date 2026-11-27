/**
 * The one Inbox item of a Junior pull request. It holds every ask on the
 * pull request, and each person on it has their own:
 *
 * - The requester reviews it, merges it, or marks a draft ready
 *   (`pull-request-action.ts`).
 * - Each other requested reviewer reviews it.
 *
 * A merge conflict has its own item (`merge-conflict-checks/policy.ts`).
 *
 * The Inbox reads each viewer's ask from the live card (`pullRequestAsk`).
 * The item's own text says every ask, for Slack and for when GitHub is down.
 * A person who no longer has an ask leaves the item, such as a reviewer who
 * submitted a review. The item closes when nobody is left.
 */
import type { PluginInboxItems } from "@sentry/junior-plugin-api";
import type { GitHubPullRequestAction } from "../db/schema.js";
import {
  GITHUB_INBOX_SUBJECTS,
  pullRequestSubject,
} from "../inbox-subjects.js";
import type { GitHubReviewAskReason } from "../pull-request-review-again.js";
import type { GitHubPullRequestMergeState } from "./installation-requests.js";

type CloseReason = { reason: string; status: "done" | "dismissed" };

/** A pull request state in which it is no longer open. */
export type EndedState = Exclude<GitHubPullRequestMergeState["state"], "open">;

/** Why the item closes when its pull request is no longer open. */
export const ENDED_REASONS: Record<EndedState, CloseReason> = {
  closed: {
    reason: "The pull request closed without merging.",
    status: "dismissed",
  },
  merged: { reason: "The pull request merged.", status: "done" },
};

/** Why the item closes when nobody on it has an ask now. */
function closeReason(
  state: GitHubPullRequestMergeState,
  previous: GitHubPullRequestAction | undefined,
  mergeAccess: boolean | undefined,
): CloseReason {
  if (previous === "merge") {
    if (state.autoMerge) {
      return { reason: "Auto-merge is on.", status: "dismissed" };
    }
    if (mergeAccess === false) {
      return {
        reason: "Only a person with write access can merge it.",
        status: "dismissed",
      };
    }
    if (state.baseOpen) {
      return {
        reason: "It merges after the pull request below it.",
        status: "dismissed",
      };
    }
    return {
      reason: "The pull request is no longer ready to merge.",
      status: "dismissed",
    };
  }
  return { reason: "The review request ended.", status: "done" };
}

/** The item text that says why Junior asked for the review again. */
const REVIEW_AGAIN_TEXT: Record<GitHubReviewAskReason, string> = {
  checks: "Checks now pass, and every comment is handled.",
  handled: "Every comment on your review is handled.",
  question: "A comment asks you a question.",
};

/** The item text that gives the requester their action. */
function requesterText(
  action: GitHubPullRequestAction,
  number: number,
  reason: GitHubReviewAskReason | undefined,
  state: GitHubPullRequestMergeState,
): string {
  if (action === "merge") {
    // The text stays true when someone approves later, because the item
    // changes only when the action changes.
    return state.reviewOutcome === "approved"
      ? `#${number} is approved, and GitHub says that it can merge.`
      : `GitHub says that #${number} can merge with no review. Review it, then merge it.`;
  }
  const asked = reason ? REVIEW_AGAIN_TEXT[reason] : undefined;
  if (action === "review") {
    return asked ?? `GitHub asks you to review #${number}.`;
  }
  if (action === "mark_ready") {
    return `You approved #${number}. Mark it ready for review.`;
  }
  const step = `#${number} is a draft. Review it, then mark it ready for review.`;
  return asked ? `${asked} ${step}` : step;
}

/**
 * Add, change, or close the item of one pull request from what GitHub says
 * now. Only the people that this event gives an ask join the item and get a
 * push: the requester when their action changes, and a reviewer when GitHub
 * requests their review.
 */
export async function showPullRequestItem(
  items: PluginInboxItems,
  args: {
    /** The requester's review or merge, if they have one. */
    action: GitHubPullRequestAction | undefined;
    askedReviewerIdentityIds: string[];
    /** Undefined when this sync did not read it. */
    mergeAccess: boolean | undefined;
    number: number;
    previous: GitHubPullRequestAction | undefined;
    pullRequestId: string;
    reason: GitHubReviewAskReason | undefined;
    requester: { asked: boolean; identityId: string };
    reviewerIdentityIds: string[];
    state: GitHubPullRequestMergeState;
  },
): Promise<void> {
  const { action, number, state } = args;
  const subject = pullRequestSubject(
    GITHUB_INBOX_SUBJECTS.pullRequest,
    args.pullRequestId,
  );
  if (state.state !== "open") {
    await items.close({ subject, ...ENDED_REASONS[state.state] });
    return;
  }
  const requesterAsks = action !== undefined;
  const reviewers = args.reviewerIdentityIds.filter(
    (identityId) => identityId !== args.requester.identityId,
  );
  const assignees = [
    ...(requesterAsks ? [args.requester.identityId] : []),
    ...reviewers,
  ];
  if (assignees.length === 0) {
    await items.close({
      subject,
      ...closeReason(state, args.previous, args.mergeAccess),
    });
    return;
  }
  // The URL stands alone, so the dashboard shows the pull request as one
  // card that carries its title. The text names it by number only. The
  // Inbox hides the review and merge text under a row head that says it,
  // so keep it in step with `textRepeatsHead` there.
  const review = `GitHub asks you to review #${number}.`;
  const requesterLine =
    action && requesterText(action, number, args.reason, state);
  const lines = [
    ...(requesterLine ? [requesterLine] : []),
    ...(reviewers.length > 0 && requesterLine !== review ? [review] : []),
  ];
  await items.upsert({
    askedIdentityIds: [
      ...(requesterAsks && args.requester.asked
        ? [args.requester.identityId]
        : []),
      ...args.askedReviewerIdentityIds.filter((identityId) =>
        reviewers.includes(identityId),
      ),
    ],
    assigneeIdentityIds: assignees,
    body: `${lines.join("\n\n")}\n\n${state.url}`,
    subject,
    title: `${action === "merge" ? "Ready to merge" : "Review requested"} · #${number}`,
    waitsOnAssignees: true,
  });
}
