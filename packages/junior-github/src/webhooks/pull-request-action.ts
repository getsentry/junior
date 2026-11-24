/**
 * The next action of a Junior pull request for its requester, and its one
 * item in the Inbox.
 *
 * The action derives from GitHub state. It is "merge" when the pull request
 * is open, not a draft, approved, auto-merge is off, and GitHub's merge state
 * is `clean`. Otherwise it is "review" while GitHub asks the requester for a
 * review. When the requester still requests changes and comments or reviews
 * after GitHub last asked them, the action ends, even while GitHub still
 * asks them, because Junior acts next.
 *
 * After a change request, only an explicit signal asks the requester again:
 * Junior marks every comment of it addressed or declined, and the required
 * checks pass (`pull-request-review-again.ts`). Pushes, base-branch syncs,
 * comments, and replies never ask on their own. When the checks had not
 * passed at the last mark, the ask is held. A later webhook, such as a
 * completed check suite, then asks on GitHub once they pass, so GitHub
 * notifies the requester, and shows the item. A comment or review by the
 * reviewer after the hold drops it, because Junior acts next. The item text
 * says why it asks: every comment is handled, or the checks now pass. Other
 * review requests from GitHub get a general text. One GitHub read gives the
 * state and each side's latest activity. A comment by another person needs
 * no read.
 *
 * One `pull_request` item per pull request holds every ask on it
 * (`pull-request-item.ts`): the requester's review or merge, and the review
 * of each other requested reviewer. Each webhook that can change one of
 * these facts reads them again from GitHub and changes the item. A person
 * joins it, and gets a push, only with the event that gives them an ask: a
 * review request for them, or a new action of the requester. Junior saves
 * the derived action, so it knows when the requester's action changes. A
 * merge conflict has its own item.
 *
 * The item goes to the Conversation where a person asked Junior to open the
 * pull request. Each person is assigned only when they are in that
 * Conversation, and it waits on them. Junior maps a GitHub login to a
 * person only through a GitHub account that they linked.
 */
import type {
  ConversationInboxItemChange,
  PluginCodeChanges,
  PluginConversationInboxItems,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import {
  GITHUB_INBOX_SUBJECTS,
  pullRequestSubject,
} from "../inbox-subjects.js";
import {
  ENDED_REASONS,
  showPullRequestItem,
  type EndedState,
} from "./pull-request-item.js";
import type { GitHubDb } from "../db/database.js";
import type { GitHubPullRequestAction } from "../db/schema.js";
import {
  claimGitHubPullRequestReadySync,
  findGitHubPullRequest,
  releaseGitHubPullRequestReadySync,
  setGitHubPullRequestNextAction,
} from "../pull-request-outcomes/store.js";
import { GITHUB_CONFLICT_GONE_REASON } from "../merge-conflict-checks/policy.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import {
  dropGitHubReviewAsked,
  dropHeldGitHubReviewAsk,
  type GitHubReviewAskReason,
  readGitHubReviewAsked,
  readHeldGitHubReviewAsk,
  readReviewAgainReadiness,
} from "../pull-request-review-again.js";
import { checkSuitePullRequests } from "./check-suite.js";
import {
  dropGitHubReviewRequested,
  markGitHubReviewRequested,
  readGitHubReviewRequested,
} from "./review-requests.js";
import { logFailOpenFailure } from "./fail-open-log.js";
import {
  loadPullRequestMergeState,
  loadReviewAgainReader,
  requestPullRequestReviewers,
  type GitHubInstallationEnv,
  type GitHubPullRequestActivity,
  type GitHubPullRequestMergeState,
} from "./installation-requests.js";
import { botUserIdFromEmail } from "./ownership.js";
import type { GitHubPullRequestTarget } from "./pull-request-people.js";

// Pull requests that one delivery syncs at once, under GitHub rate limits.
const PULL_REQUEST_SYNC_CONCURRENCY = 5;

/**
 * A check normally takes a few seconds. After this time, a check that
 * stopped without its release no longer blocks new checks.
 */
const READY_SYNC_STALE_MS = 60_000;

/** Webhook actions that can change the next action of a pull request. */
const ACTION_EVENTS: Record<string, ReadonlySet<string>> = {
  pull_request: new Set([
    "auto_merge_disabled",
    "auto_merge_enabled",
    "closed",
    "converted_to_draft",
    "ready_for_review",
    "reopened",
    "review_request_removed",
    "review_requested",
    "synchronize",
  ]),
  pull_request_review: new Set(["dismissed", "submitted"]),
};

/** A pull request whose next action one webhook delivery can change. */
export interface GitHubPullRequestActionTarget extends GitHubPullRequestTarget {
  /**
   * The login of a comment's author. A comment changes the next action only
   * when the requester wrote it, so the check skips comments by other
   * people and by Junior with no GitHub read.
   */
  commentBy?: string;
  /** The login of the reviewer that a `review_requested` webhook asks. */
  reviewRequested?: string;
}

const repositorySchema = z.object({ full_name: z.string().min(1) });

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: repositorySchema,
  // A team review request has no reviewer person.
  requested_reviewer: z.object({ login: z.string().min(1) }).nullish(),
});

// The comment webhooks that a person or Junior's App sends by commenting
// on a pull request. Only a pull request's issue carries `pull_request`.
// A deleted account's comment has a null `user`.
const commentWebhookSchema = z.object({
  action: z.literal("created"),
  comment: z.object({
    user: z.object({ login: z.string().min(1) }).nullable(),
  }),
  issue: z
    .object({ number: z.number().int().positive(), pull_request: z.object({}) })
    .optional(),
  pull_request: z.object({ number: z.number().int().positive() }).optional(),
  repository: repositorySchema,
});

/** Return the pull requests whose next action one webhook delivery can change. */
export function pullRequestActionTargets(
  eventName: string,
  body: unknown,
): GitHubPullRequestActionTarget[] {
  if (eventName === "check_suite") return checkSuitePullRequests(body);
  if (
    eventName === "issue_comment" ||
    eventName === "pull_request_review_comment"
  ) {
    const parsed = commentWebhookSchema.safeParse(body);
    if (!parsed.success) return [];
    const { comment, repository } = parsed.data;
    const number = (parsed.data.issue ?? parsed.data.pull_request)?.number;
    // A comment by a deleted account is not by the requester.
    if (number === undefined || !comment.user) return [];
    return [
      {
        commentBy: comment.user.login,
        number,
        repositoryFullName: repository.full_name,
      },
    ];
  }
  const actions = ACTION_EVENTS[eventName];
  const parsed = pullRequestWebhookSchema.safeParse(body);
  if (!actions || !parsed.success || !actions.has(parsed.data.action)) {
    return [];
  }
  const reviewer =
    parsed.data.action === "review_requested"
      ? parsed.data.requested_reviewer?.login
      : undefined;
  return [
    {
      number: parsed.data.pull_request.number,
      repositoryFullName: parsed.data.repository.full_name,
      ...(reviewer ? { reviewRequested: reviewer } : undefined),
    },
  ];
}

function sameLogin(a: string, b: string | undefined): boolean {
  return b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * When GitHub last asked the requester for a review, and when the requester
 * last commented or reviewed.
 */
interface LatestActivity {
  askedAt?: Date;
  requesterAt?: Date;
}

function latestActivity(
  activity: GitHubPullRequestActivity[],
  requesterLogin: string | undefined,
): LatestActivity {
  const latest: LatestActivity = {};
  for (const entry of activity) {
    if (!sameLogin(entry.login, requesterLogin)) continue;
    const key = entry.kind === "reviewRequest" ? "askedAt" : "requesterAt";
    const saved = latest[key];
    if (!saved || entry.at > saved) latest[key] = entry.at;
  }
  return latest;
}

// A missing time is older than every time.
function timeOf(at: Date | undefined): number {
  return at ? at.getTime() : Number.NEGATIVE_INFINITY;
}

/**
 * Derive the requester's next action. Return undefined when it cannot be
 * known yet, so a later event decides.
 */
function nextAction(
  state: GitHubPullRequestMergeState,
  requester: {
    actedLast: boolean;
    askedAgain: boolean;
    login: string | undefined;
  },
  saved: GitHubPullRequestAction | undefined,
): { action?: GitHubPullRequestAction } | undefined {
  if (state.state !== "open") return {};
  // With auto-merge on, GitHub merges it, so no person needs to.
  const canMerge = !state.draft && !state.autoMerge;
  if (canMerge && state.mergeableState === "clean" && state.approved) {
    return { action: "merge" };
  }
  // GitHub has not computed the merge state yet, such as after a push. The
  // merge can still be the action, so it stays until a later event decides.
  if (canMerge && !state.mergeableState && saved === "merge") return undefined;
  if (requester.askedAgain) return { action: "review" };
  const requested = isRequested(state, requester.login);
  // A reply to the change request ends the review that Junior asked for,
  // though GitHub still asks for it, because Junior acts next.
  if (requested && (!requester.actedLast || !state.changesRequested)) {
    return { action: "review" };
  }
  if (canMerge && !state.mergeableState) return undefined;
  return {};
}

function isRequested(
  state: GitHubPullRequestMergeState,
  login: string | undefined,
): boolean {
  const lower = login?.toLowerCase();
  return state.requestedReviewers.some(
    (reviewer) => reviewer.toLowerCase() === lower,
  );
}

/**
 * Return the close of the item of a pull request that merged or closed,
 * with the conversation that owns it. Undefined when no person asked Junior
 * for the pull request. The outcome write saves it in one batch with that
 * conversation's chip, so no reader sees an ended pull request next to its
 * open item.
 */
export async function endedGitHubPullRequestItemChanges(args: {
  db: GitHubDb;
  state: EndedState;
  /** The pull request, with GitHub's id, the id of its items. */
  target: GitHubPullRequestTarget & { pullRequestId: string };
}): Promise<
  | { conversationId: string; inboxItems: ConversationInboxItemChange[] }
  | undefined
> {
  const { target } = args;
  const conversationId = (
    await listGitHubPullRequestOpeners(args.db, {
      numbers: [target.number],
      repositoryFullName: target.repositoryFullName,
    })
  ).get(target.number)?.conversationId;
  if (!conversationId) return undefined;
  const reason = ENDED_REASONS[args.state];
  return {
    conversationId,
    inboxItems: [
      GITHUB_INBOX_SUBJECTS.pullRequest,
      GITHUB_INBOX_SUBJECTS.mergeConflict,
    ].map((kind) => ({
      close: {
        subject: pullRequestSubject(kind, target.pullRequestId),
        ...reason,
      },
      conversationId,
    })),
  };
}

/**
 * Ask for a reviewer's review on GitHub, so GitHub notifies them, and return
 * whether GitHub took the request. The item already asks, so a failure is
 * logged and the item stays.
 */
async function requestReviewAgain(
  args: {
    env: GitHubInstallationEnv;
    log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  },
  target: GitHubPullRequestTarget,
  login: string,
): Promise<boolean> {
  try {
    await requestPullRequestReviewers(args.env, {
      ...target,
      reviewers: [login],
    });
    return true;
  } catch (error) {
    logFailOpenFailure(args.log, "GitHub review request again failed", error, {
      number: target.number,
      repository: target.repositoryFullName,
    });
    return false;
  }
}

/**
 * Ask the reviewer of a held review ask again once the required checks
 * pass, and return their login and the reason. Keep the hold while the
 * checks have not passed, or while GitHub does not take the request, so a
 * later webhook asks again. Drop it when the pull request ended, when the
 * reviewer commented or reviewed since, or when their change request is no
 * longer ready.
 */
async function askHeldReview(
  args: {
    botEmail: string | undefined;
    env: GitHubInstallationEnv;
    log?: Pick<PluginLogger, "error" | "warn"> | undefined;
    state: PluginState;
  },
  target: GitHubPullRequestTarget,
  state: GitHubPullRequestMergeState,
): Promise<{ reason: GitHubReviewAskReason; reviewer: string } | undefined> {
  const held = await readHeldGitHubReviewAsk(args.state, target);
  if (!held) return undefined;
  const heldAt = new Date(held.at);
  const botUserId = botUserIdFromEmail(args.botEmail);
  const actedSince = state.activity.some(
    (entry) =>
      entry.kind === "author" &&
      sameLogin(entry.login, held.reviewer) &&
      entry.at > heldAt,
  );
  if (state.state !== "open" || actedSince || botUserId === undefined) {
    await dropHeldGitHubReviewAsk(args.state, target);
    return undefined;
  }
  const [owner = "", name = ""] = target.repositoryFullName.split("/");
  const readiness = await readReviewAgainReadiness(
    await loadReviewAgainReader(args.env, target.repositoryFullName),
    {
      botUserId,
      marked: held.marked,
      name,
      number: target.number,
      owner,
      reviewer: held.reviewer,
    },
  );
  if (readiness === "checks") return undefined;
  if (readiness === "ready") {
    if (await requestReviewAgain(args, target, held.reviewer)) {
      await dropHeldGitHubReviewAsk(args.state, target);
    }
    return { reason: held.reason, reviewer: held.reviewer };
  }
  await dropHeldGitHubReviewAsk(args.state, target);
  return undefined;
}

/**
 * Return why Junior asked the requester again, if it did: the reason of the
 * held ask that this sync released, or `handled` when the feedback tool
 * asked them and they have not acted since.
 */
async function askReason(
  state: PluginState,
  target: GitHubPullRequestTarget,
  args: {
    asked: { reason: GitHubReviewAskReason; reviewer: string } | undefined;
    requesterAt: Date | undefined;
    requesterLogin: string | undefined;
  },
): Promise<GitHubReviewAskReason | undefined> {
  if (args.asked !== undefined) {
    return sameLogin(args.asked.reviewer, args.requesterLogin)
      ? args.asked.reason
      : undefined;
  }
  const asked = await readGitHubReviewAsked(state, target);
  return asked &&
    sameLogin(asked.reviewer, args.requesterLogin) &&
    timeOf(args.requesterAt) <= Date.parse(asked.at)
    ? "handled"
    : undefined;
}

/** What one sync of a pull request's items needs. */
interface GitHubPullRequestItemSync {
  botEmail: string | undefined;
  codeChanges: Pick<PluginCodeChanges, "list">;
  db: GitHubDb;
  env: GitHubInstallationEnv;
  /** Find the people who linked these GitHub logins. */
  findLinkedIdentityIds(
    logins: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  loadGitHubLogin?:
    | ((identityId: string) => Promise<string | undefined>)
    | undefined;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  inboxItems: PluginConversationInboxItems;
  /** Holds the review asks that wait for the required checks. */
  state: PluginState;
}

/** Read one Junior pull request from GitHub and change its items. */
async function syncOne(
  args: GitHubPullRequestItemSync,
  target: GitHubPullRequestActionTarget,
): Promise<void> {
  const opener = (
    await listGitHubPullRequestOpeners(args.db, {
      numbers: [target.number],
      repositoryFullName: target.repositoryFullName,
    })
  ).get(target.number);
  // Only a pull request that a person asked Junior to open has a requester
  // and a Conversation for the item.
  if (!opener?.conversationId) return;
  const items = args.inboxItems.forConversation(opener.conversationId);
  const requesterLogin = await args.loadGitHubLogin?.(opener.identityId);
  if (
    target.commentBy !== undefined &&
    !sameLogin(target.commentBy, requesterLogin)
  ) {
    return;
  }
  // Junior owns only the pull requests in its code index.
  const pullRequestId = (await findGitHubPullRequest(args.codeChanges, target))
    ?.providerId;
  if (!pullRequestId) return;
  // Save the reviewer before the claim, so the check that runs asks them,
  // also when another webhook's check holds the claim.
  if (target.reviewRequested) {
    await markGitHubReviewRequested(args.state, target, target.reviewRequested);
  }
  // One webhook at a time checks a pull request. A webhook that arrives
  // during a check asks again, and the running webhook checks once more with
  // a new GitHub read. No connection or lock stays open during the calls.
  const claim = await claimGitHubPullRequestReadySync(args.db, pullRequestId, {
    now: new Date(),
    staleMs: READY_SYNC_STALE_MS,
  });
  if (!claim) return;
  const { id } = claim;
  let saved = claim.action;
  let requests: number | undefined = claim.requests;
  // A failed check still checks the requests that came in during it. The
  // first failure is thrown after the last check.
  let failure: unknown;
  // One check: read GitHub, change the item, and return the saved action.
  const check = async (
    previous: GitHubPullRequestAction | undefined,
  ): Promise<GitHubPullRequestAction | undefined> => {
    const state = await loadPullRequestMergeState(
      args.env,
      target,
      requesterLogin,
    );
    const activity = latestActivity(state.activity, requesterLogin);
    const asked = await askHeldReview(args, target, state);
    const reason = await askReason(args.state, target, {
      asked,
      requesterAt: activity.requesterAt,
      requesterLogin,
    });
    const next = nextAction(
      state,
      {
        actedLast: timeOf(activity.requesterAt) > timeOf(activity.askedAt),
        askedAgain: asked !== undefined && reason !== undefined,
        login: requesterLogin,
      },
      previous,
    );
    // When the action cannot be known yet, the saved one stays until a
    // later event decides.
    const changed = next !== undefined && next.action !== previous;
    const action = next === undefined ? previous : next.action;
    // The requester's review is their action, so the other reviewers are
    // the other people whose review GitHub requests.
    const reviewers = state.requestedReviewers.filter(
      (login) => !sameLogin(login, requesterLogin),
    );
    const newlyRequested = await readGitHubReviewRequested(
      args.state,
      target,
      reviewers,
    );
    const linked = await args.findLinkedIdentityIds(reviewers);
    await showPullRequestItem(items, {
      action,
      askedReviewerIdentityIds: newlyRequested.flatMap(
        (login) => linked.get(login) ?? [],
      ),
      number: target.number,
      previous,
      pullRequestId,
      reason,
      requester: {
        asked: changed && next.action !== undefined,
        identityId: opener.identityId,
      },
      reviewerIdentityIds: reviewers.flatMap(
        (login) => linked.get(login.toLowerCase()) ?? [],
      ),
      state,
    });
    // Drop the requests only after the item shows them, so a failure asks
    // again in the next check.
    await dropGitHubReviewRequested(args.state, target, newlyRequested);
    // The same read closes the merge conflict item from
    // `merge-conflict-checks/policy.ts` when the conflict is gone.
    if (
      state.state !== "open" ||
      (state.mergeableState && state.mergeableState !== "dirty")
    ) {
      await items.close({
        subject: pullRequestSubject(
          GITHUB_INBOX_SUBJECTS.mergeConflict,
          pullRequestId,
        ),
        ...(state.state === "open"
          ? { reason: GITHUB_CONFLICT_GONE_REASON, status: "done" as const }
          : ENDED_REASONS[state.state]),
      });
    }
    if (changed && next.action === "review" && reason === "handled") {
      await dropGitHubReviewAsked(args.state, target);
    }
    if (!changed) return previous;
    // Save after the item changes, so a failure leaves the old action and
    // the next event tries again.
    await setGitHubPullRequestNextAction(args.db, pullRequestId, next.action);
    return next.action;
  };
  while (requests !== undefined) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each check reads GitHub again for the requests that came in during the check before.
      saved = await check(saved);
    } catch (error) {
      failure ??= error;
    }
    // oxlint-disable-next-line no-await-in-loop -- Each check reads GitHub again for the requests that came in during the check before.
    requests = await releaseGitHubPullRequestReadySync(args.db, pullRequestId, {
      id,
      requests,
    });
  }
  if (failure !== undefined) throw failure;
}

/**
 * Add, change, or close the item of each Junior pull request that a webhook
 * delivery can change. The item is optional, so a failure is logged and
 * does not fail the delivery.
 */
export async function syncGitHubPullRequestActions(
  args: GitHubPullRequestItemSync & {
    deliveryId: string;
    targets: GitHubPullRequestActionTarget[];
  },
): Promise<void> {
  await pLimit(PULL_REQUEST_SYNC_CONCURRENCY).map(
    args.targets,
    async (target) => {
      try {
        await syncOne(args, target);
      } catch (error) {
        logFailOpenFailure(
          args.log,
          "GitHub pull request action failed",
          error,
          {
            deliveryId: args.deliveryId,
            number: target.number,
            repository: target.repositoryFullName,
          },
        );
      }
    },
  );
}
