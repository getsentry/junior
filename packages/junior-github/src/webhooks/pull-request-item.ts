/**
 * The one Inbox item of a Junior pull request. It holds every ask on the
 * pull request, and each person on it has their own:
 *
 * - The requester reviews it or merges it (`pull-request-action.ts`), and
 *   resumes a merge conflict fix that did not land
 *   (`merge-conflict-checks/policy.ts`).
 * - Each other requested reviewer reviews it.
 *
 * The Inbox reads each viewer's ask from the live card (`pullRequestAsk`).
 * The item's own text says every ask, for Slack and for when GitHub is down.
 * A person who no longer has an ask leaves the item, such as a reviewer who
 * submitted a review. The item closes when nobody is left.
 */
import type { PluginInboxItems } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import {
  juniorGitHubPullRequests,
  type GitHubPullRequestAction,
} from "../db/schema.js";
import { pullRequestSubject } from "../inbox-subjects.js";
import { GITHUB_CONFLICT_RESUME } from "../merge-conflict-checks/policy.js";
import { pullRequestRow } from "../pull-request-outcomes/store.js";
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
  conflict: ConflictAsk,
): CloseReason {
  if (conflict?.state === "ended") {
    return { reason: "The merge conflict is gone.", status: "done" };
  }
  if (previous === "merge") {
    return state.autoMerge
      ? { reason: "Auto-merge is on.", status: "dismissed" }
      : {
          reason: "The pull request is no longer ready to merge.",
          status: "dismissed",
        };
  }
  return { reason: "The review request ended.", status: "done" };
}

/** The item text that says why Junior asked for the review again. */
const REVIEW_AGAIN_TEXT: Record<GitHubReviewAskReason, string> = {
  checks: "Checks now pass, and every comment is handled.",
  handled: "Every comment on your change request is handled.",
};

/**
 * The requester's merge conflict ask: `asked` when the policy asked them to
 * resume a fix that did not land, after their latest Resume, and GitHub
 * still reports the conflict. `ended` when GitHub reports no conflict now.
 */
export type ConflictAsk =
  | { askedAt: Date; state: "asked" | "ended" }
  | undefined;

/** Read the requester's merge conflict ask (`ConflictAsk`). */
export async function readConflictAsk(
  db: GitHubDb,
  target: { number: number; repositoryFullName: string },
  state: GitHubPullRequestMergeState,
): Promise<ConflictAsk> {
  const t = juniorGitHubPullRequests;
  const [row] = await db
    .select({
      askedAt: t.conflictFixAskedAt,
      resumedAt: t.conflictFixesResumedAt,
    })
    .from(t)
    .where(pullRequestRow(target))
    .limit(1);
  if (!row?.askedAt) return undefined;
  const { askedAt } = row;
  // An unknown merge state keeps the ask until GitHub computes it.
  const gone =
    state.state !== "open" ||
    (state.mergeableState !== undefined && state.mergeableState !== "dirty");
  if (gone) return { askedAt, state: "ended" };
  return askedAt > (row.resumedAt ?? new Date(0))
    ? { askedAt, state: "asked" }
    : undefined;
}

/**
 * Forget an ended conflict ask that the requester did not dismiss, so a
 * later fix that does not land asks again. After a Dismiss, Junior does
 * not ask again until the next Resume.
 */
export async function forgetConflictAsk(
  db: GitHubDb,
  target: { number: number; repositoryFullName: string },
  askedAt: Date,
): Promise<void> {
  const t = juniorGitHubPullRequests;
  await db
    .update(t)
    .set({ conflictFixAskedAt: null })
    .where(and(pullRequestRow(target), eq(t.conflictFixAskedAt, askedAt)));
}

/**
 * Add, change, or close the item of one pull request from what GitHub says
 * now. Only the people that this event gives an ask join the item and get a
 * push: the requester when their action changes or the conflict policy
 * asks them, and a reviewer when GitHub requests their review. Return
 * whether the requester was on the open item, so did not dismiss it.
 */
export async function showPullRequestItem(
  items: PluginInboxItems,
  args: {
    /** The requester's review or merge, if they have one. */
    action: GitHubPullRequestAction | undefined;
    askedReviewerIdentityIds: string[];
    conflict: ConflictAsk;
    number: number;
    previous: GitHubPullRequestAction | undefined;
    pullRequestId: string;
    reason: GitHubReviewAskReason | undefined;
    requester: { asked: boolean; identityId: string };
    reviewerIdentityIds: string[];
    state: GitHubPullRequestMergeState;
  },
): Promise<boolean> {
  const { action, number, state } = args;
  const conflict = args.conflict?.state === "asked";
  const subject = pullRequestSubject(args.pullRequestId);
  if (state.state !== "open") {
    return await items.close({ subject, ...ENDED_REASONS[state.state] });
  }
  const requesterAsks = action !== undefined || conflict;
  const reviewers = args.reviewerIdentityIds.filter(
    (identityId) => identityId !== args.requester.identityId,
  );
  const assignees = [
    ...(requesterAsks ? [args.requester.identityId] : []),
    ...reviewers,
  ];
  if (assignees.length === 0) {
    return await items.close({
      subject,
      ...closeReason(state, args.previous, args.conflict),
    });
  }
  // The URL stands alone, so the dashboard shows the pull request as one
  // card that carries its title. The text names it by number only. The
  // Inbox hides the review and merge text under a row head that says it,
  // so keep it in step with `textRepeatsHead` there.
  const review = `GitHub asks you to review #${number}.`;
  const lines = [
    ...(action === "merge"
      ? [`#${number} is approved, and GitHub says that it can merge.`]
      : []),
    ...(action === "review"
      ? [args.reason ? REVIEW_AGAIN_TEXT[args.reason] : review]
      : []),
    ...(reviewers.length > 0 && !(action === "review" && !args.reason)
      ? [review]
      : []),
    ...(conflict
      ? [
          `#${number} conflicts with its base branch, and the last fix did not land. Resume tries again. Dismiss stops these asks for this pull request.`,
        ]
      : []),
  ];
  const title = conflict
    ? "Merge conflict"
    : action === "merge"
      ? "Ready to merge"
      : "Review requested";
  const wereOn = await items.upsert({
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
    ...(conflict
      ? { choices: [{ label: GITHUB_CONFLICT_RESUME }] }
      : undefined),
    subject,
    title: `${title} · #${number}`,
    waitsOnAssignees: true,
  });
  return wereOn.includes(args.requester.identityId);
}
