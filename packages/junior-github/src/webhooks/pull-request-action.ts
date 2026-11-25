/**
 * The next action of a Junior pull request for its requester, and its one
 * item in the Inbox.
 *
 * The action derives from GitHub state. It is "merge" when the pull request
 * is open, not a draft, auto-merge is off, GitHub's merge state is `clean`,
 * no reviewer still requests changes, and GitHub requests no review. GitHub
 * gives `blocked` until a required review approves, so a pull request with
 * no approval is "merge" only where GitHub requires no review, and its item
 * asks the requester to review it first. A pending review request comes
 * before the merge even there. Otherwise it is "review" while GitHub asks
 * the requester for a review. A request for only someone else gives no
 * action, because the pull request waits on them. When the requester still
 * requests changes and comments or reviews after GitHub last asked them,
 * the action ends, even while GitHub still asks them, because Junior acts
 * next.
 *
 * A review that GitHub asks for on a draft is "review_draft": the requester
 * reviews it and marks it ready. Junior keeps a draft for its requester when
 * marking it ready would ask the code owners, and asks only the requester on
 * GitHub (`github_updatePullRequest` `request_review`). When the draft
 * becomes ready, the same item says that GitHub asks for the review. When
 * the requester approves a draft that stays a draft, such as one that the
 * repo's AGENTS.md leaves for a person to mark ready, the action is
 * "mark_ready", and the same item says to mark it ready. It needs no new
 * review request, so none lingers after that.
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
 * A pull request is in limbo when it waits on nobody: it is ready, the
 * action is none, and no person or rule moves it on. Once its required
 * checks pass, the sync asks for the requester's review on GitHub, as Junior
 * does when a draft becomes ready, and the review request then shows the
 * item. So each ready pull request that the requester has not seen has an
 * item or a pending review request, also one opened before the requester
 * linked GitHub. Pushes do not ask a requester who reviewed or commented
 * again, so a webhook asks only one who has not. A comment-only review is
 * not an answer: GitHub drops the ask on it, and the sync asks again at
 * once (`requesterReviewAsk`). A requester who removed their own review
 * request is not asked again until someone else asks them.
 *
 * The requester takes one action, not both, so one item per pull request
 * shows it. Each webhook that can change one of these facts reads them
 * again from GitHub. Junior saves the derived action and changes the item
 * only when the action changes. GitHub does not send a failed webhook
 * again, so when GitHub fails the read for a while, such as when the
 * installation is out of GraphQL rate limit, a started task syncs the pull
 * request again later.
 *
 * The item goes to the Conversation where a person asked Junior to open the
 * pull request. It is assigned to that person only when they are in that
 * Conversation, and it waits on them. Junior maps a GitHub login to a person
 * only through the requester's linked GitHub account.
 */
import type {
  ConversationInboxItemChange,
  PluginCodeChanges,
  PluginConversationInboxItems,
  PluginLogger,
  PluginInboxItems,
  PluginStartedTaskContext,
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
  InboxItemSubjectTitleParts,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { loadGitHubTitleParts } from "./title-parts.js";
import { GitHubRequestError } from "../credential-support.js";
import { type GitHubDb, gitHubDbSchema } from "../db/database.js";
import type { GitHubPullRequestAction } from "../db/schema.js";
import {
  claimGitHubPullRequestReadySync,
  findGitHubPullRequest,
  releaseGitHubPullRequestReadySync,
  setGitHubPullRequestNextAction,
} from "../pull-request-outcomes/store.js";
import {
  GITHUB_CONFLICT_GONE_REASON,
  gitHubConflictItemKey,
} from "../merge-conflict-checks/policy.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import {
  dropGitHubReviewAsked,
  dropHeldGitHubReviewAsk,
  type GitHubReviewAskReason,
  readGitHubReviewAsked,
  readHeldGitHubReviewAsk,
  readGitHubRequiredChecksPass,
  readReviewAgainReadiness,
} from "../pull-request-review-again.js";
import { linkedGitHubLogin } from "../tool-support/attribution.js";
import { checkSuitePullRequests } from "./check-suite.js";
import { logFailOpenFailure } from "./fail-open-log.js";
import { GitHubGraphqlError } from "./graphql-request.js";
import {
  loadGraphqlRateLimitReset,
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

/**
 * Keys of the two items that came before the one item per pull request.
 * Each check closes them, so no old item stays open next to the new one.
 * Remove them when no item from before is open.
 */
const LEGACY_DEDUPE_PREFIXES = [
  "pull-request-ready:",
  "pull-request-review-requested:",
] as const;

function itemName(target: GitHubPullRequestTarget): string {
  return `${target.repositoryFullName}#${target.number}`.toLowerCase();
}

function actionDedupeKey(target: GitHubPullRequestTarget): string {
  return `pull-request-action:${itemName(target)}`;
}

async function closeLegacyItems(
  items: PluginInboxItems,
  name: string,
): Promise<void> {
  await Promise.all(
    LEGACY_DEDUPE_PREFIXES.map((prefix) =>
      items.close({
        dedupeKey: `${prefix}${name}`,
        reason: "One item now shows the next action.",
        status: "dismissed",
      }),
    ),
  );
}

/** A pull request whose next action one webhook delivery can change. */
export interface GitHubPullRequestActionTarget extends GitHubPullRequestTarget {
  /**
   * The login of a comment's author. A comment changes the next action only
   * when the requester wrote it, so the check skips comments by other
   * people and by Junior with no GitHub read.
   */
  commentBy?: string;
}

const repositorySchema = z.object({ full_name: z.string().min(1) });

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: repositorySchema,
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
  return [
    {
      number: parsed.data.pull_request.number,
      repositoryFullName: parsed.data.repository.full_name,
    },
  ];
}

function sameLogin(a: string, b: string | undefined): boolean {
  return b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * When GitHub last asked the requester for a review, when the requester last
 * commented or reviewed, and when they last removed their own review
 * request. A comment-only review neither approves nor requests changes, so
 * `actedAt` leaves it out and `commentedAt` holds it.
 */
interface LatestActivity {
  actedAt?: Date;
  askedAt?: Date;
  commentedAt?: Date;
  removedAt?: Date;
  requesterAt?: Date;
}

function latestActivity(
  activity: GitHubPullRequestActivity[],
  requesterLogin: string | undefined,
): LatestActivity {
  const latest: LatestActivity = {};
  const keep = (key: keyof LatestActivity, at: Date) => {
    const saved = latest[key];
    if (!saved || at > saved) latest[key] = at;
  };
  for (const entry of activity) {
    if (!sameLogin(entry.login, requesterLogin)) continue;
    if (entry.kind === "reviewRequest") keep("askedAt", entry.at);
    else if (entry.kind === "reviewRequestRemoved") keep("removedAt", entry.at);
    else {
      keep("requesterAt", entry.at);
      keep(entry.review === "COMMENTED" ? "commentedAt" : "actedAt", entry.at);
    }
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
  // With auto-merge on, GitHub merges it, so no person needs to. A pending
  // review request comes first, even where GitHub requires no review.
  const canMerge = !state.draft && !state.autoMerge && !state.reviewPending;
  if (
    canMerge &&
    state.mergeableState === "clean" &&
    state.reviewOutcome !== "changesRequested"
  ) {
    return { action: "merge" };
  }
  // GitHub has not computed the merge state yet, such as after a push. The
  // merge can still be the action, so it stays until a later event decides.
  if (canMerge && !state.mergeableState && saved === "merge") return undefined;
  const review = state.draft ? "review_draft" : "review";
  if (requester.askedAgain) return { action: review };
  const requested = isRequested(state, requester.login);
  // A reply to the change request ends the review that Junior asked for,
  // though GitHub still asks for it, because Junior acts next.
  if (requested && (!requester.actedLast || !state.changesRequested)) {
    return { action: review };
  }
  // The requester approved the draft, so the step left is to mark it ready.
  if (state.draft && state.requesterApproved) return { action: "mark_ready" };
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
 * Why Junior asks for the requester's review on GitHub, for a pull request
 * whose action is none. It is open, not a draft, auto-merge is off, GitHub
 * does not ask the requester for a review, and the requester does not
 * request changes. Junior does not ask when the requester removed their
 * own review request and no one asked them since.
 *
 * `commentOnly`: the requester's latest answer to the ask is a comment-only
 * review, and they have not approved. It answers neither yes nor no, so it
 * does not end the ask that GitHub drops on it.
 *
 * `limbo`: the pull request waits on nobody. The requester has not
 * commented or reviewed since the last push, other than a comment-only
 * review. No reviewer approved it, so it does not wait only on others, and
 * no reviewer requests changes, so Junior does not act next.
 */
function requesterReviewAsk(
  state: GitHubPullRequestMergeState,
  activity: LatestActivity,
  login: string,
): "commentOnly" | "limbo" | undefined {
  if (
    state.state !== "open" ||
    state.draft ||
    state.autoMerge ||
    isRequested(state, login) ||
    state.changesRequested ||
    timeOf(activity.removedAt) > timeOf(activity.askedAt)
  ) {
    return undefined;
  }
  if (
    !state.requesterApproved &&
    timeOf(activity.commentedAt) > timeOf(activity.askedAt)
  ) {
    return "commentOnly";
  }
  return timeOf(activity.actedAt) <= timeOf(state.headCommittedAt) &&
    state.reviewOutcome === undefined
    ? "limbo"
    : undefined;
}

type CloseReason = { reason: string; status: "done" | "dismissed" };

type EndedState = Exclude<GitHubPullRequestMergeState["state"], "open">;

/** Why an item closes when its pull request is no longer open. */
const ENDED_REASONS: Record<EndedState, CloseReason> = {
  closed: {
    reason: "The pull request closed without merging.",
    status: "dismissed",
  },
  merged: { reason: "The pull request merged.", status: "done" },
};

function endedReason(
  state: GitHubPullRequestMergeState["state"],
): CloseReason | undefined {
  return state === "open" ? undefined : ENDED_REASONS[state];
}

function closeReason(
  state: GitHubPullRequestMergeState,
  previous: GitHubPullRequestAction,
): CloseReason {
  const ended = endedReason(state.state);
  if (ended) return ended;
  if (previous !== "merge") {
    return { reason: "The review request ended.", status: "done" };
  }
  if (state.autoMerge) {
    return { reason: "Auto-merge is on.", status: "dismissed" };
  }
  return {
    reason: "The pull request is no longer ready to merge.",
    status: "dismissed",
  };
}

/** The item text that says why Junior asked for the review again. */
const REVIEW_AGAIN_TEXT: Record<GitHubReviewAskReason, string> = {
  checks: "Checks now pass, and every comment is handled.",
  handled: "Every comment on your change request is handled.",
};

function actionText(
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

async function showAction(
  items: PluginInboxItems,
  args: {
    action: GitHubPullRequestAction | undefined;
    dedupeKey: string;
    identityId: string;
    number: number;
    previous: GitHubPullRequestAction | undefined;
    reason: GitHubReviewAskReason | undefined;
    state: GitHubPullRequestMergeState;
    titleParts: InboxItemSubjectTitleParts | undefined;
  },
): Promise<void> {
  const { action, number, state } = args;
  if (action) {
    await items.upsert({
      assigneeIdentityIds: [args.identityId],
      // The URL stands alone, so the dashboard shows the pull request as
      // one card that carries its title. The text names it by number only.
      // The Inbox hides the review and merge text under a row head that
      // says it, so keep it in step with `textRepeatsHead` there.
      body: `${actionText(action, number, args.reason, state)}\n\n${state.url}`,
      dedupeKey: args.dedupeKey,
      // The number stays visible where a view shows only the subject.
      subject: {
        id: state.url,
        title: `${state.title} (#${number})`,
        ...(args.titleParts ? { titleParts: args.titleParts } : undefined),
        url: state.url,
      },
      title:
        action === "merge"
          ? `Ready to merge · #${number}`
          : `Review requested · #${number}`,
      waitsOnAssignees: true,
    });
  } else if (args.previous) {
    await items.close({
      dedupeKey: args.dedupeKey,
      ...closeReason(state, args.previous),
    });
  }
}

/**
 * Return the closes of the next-action item and the merge conflict notice
 * of a pull request that merged or closed, with the conversation that owns
 * them. Undefined when no person asked Junior for the pull request. The
 * outcome write saves them in one batch with that conversation's chip, so no
 * reader sees an ended pull request next to its open item.
 */
export async function endedGitHubPullRequestItemChanges(args: {
  db: GitHubDb;
  state: EndedState;
  target: GitHubPullRequestTarget;
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
    inboxItems: [actionDedupeKey(target), gitHubConflictItemKey(target)].map(
      (dedupeKey) => ({ close: { dedupeKey, ...reason }, conversationId }),
    ),
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

/** What a sync of the next action reads and writes. */
interface PullRequestActionSyncContext {
  /**
   * Also ask in limbo when the requester reviewed or commented before the
   * last push. Only the one-off backfill does: pushes do not ask the
   * requester again.
   */
  askAfterRequesterActed?: boolean | undefined;
  botEmail: string | undefined;
  codeChanges: Pick<PluginCodeChanges, "list">;
  db: GitHubDb;
  env: GitHubInstallationEnv;
  loadGitHubLogin?:
    | ((identityId: string) => Promise<string | undefined>)
    | undefined;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  inboxItems: PluginConversationInboxItems;
  /** Holds the review asks that wait for the required checks. */
  state: PluginState;
}

async function syncOne(
  args: PullRequestActionSyncContext,
  target: GitHubPullRequestActionTarget,
): Promise<"busy" | undefined> {
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
  const name = itemName(target);
  const dedupeKey = actionDedupeKey(target);
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
  // One webhook at a time checks a pull request. A webhook that arrives
  // during a check asks again, and the running webhook checks once more with
  // a new GitHub read. No connection or lock stays open during the calls.
  const claim = await claimGitHubPullRequestReadySync(args.db, pullRequestId, {
    now: new Date(),
    staleMs: READY_SYNC_STALE_MS,
  });
  if (claim === "held") return "busy";
  if (!claim) return;
  const { id } = claim;
  let saved = claim.action;
  let requests: number | undefined = claim.requests;
  // A failed check still checks the requests that came in during it. The
  // first failure is thrown after the last check.
  let failure: unknown;
  // Ask the requester once per sync, so a request that GitHub takes but
  // does not show yet cannot ask again.
  let askedRequester = false;
  // One check: read GitHub, change the items, and return the saved action.
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
    const ask =
      !askedRequester &&
      requesterLogin &&
      next !== undefined &&
      next.action === undefined
        ? requesterReviewAsk(state, activity, requesterLogin)
        : undefined;
    if (
      requesterLogin &&
      (ask === "commentOnly" ||
        (ask === "limbo" &&
          (args.askAfterRequesterActed || activity.actedAt === undefined)))
    ) {
      askedRequester = true;
      // A pull request in limbo waits for the required checks, as a review
      // ask again does. A later check suite webhook syncs again. A
      // comment-only review only puts back the ask that it ended.
      const [owner = "", name = ""] = target.repositoryFullName.split("/");
      const checksPass =
        ask === "commentOnly" ||
        (await readGitHubRequiredChecksPass(
          await loadReviewAgainReader(args.env, target.repositoryFullName),
          { name, number: target.number, owner },
        ));
      // The next read sees the request and shows its item.
      if (
        checksPass &&
        (await requestReviewAgain(args, target, requesterLogin))
      ) {
        return await check(previous);
      }
    }
    // Act only on a change. So repeat events add no second item, and an
    // item that a person closed does not come back until the action
    // changes. When the action cannot be known yet, a later event decides.
    const changed = next !== undefined && next.action !== previous;
    if (changed) {
      await showAction(items, {
        action: next.action,
        dedupeKey,
        identityId: opener.identityId,
        number: target.number,
        previous,
        reason,
        state,
        titleParts: next.action
          ? await loadGitHubTitleParts(
              args.env,
              {
                repositoryFullName: target.repositoryFullName,
                title: state.title,
              },
              args.log,
            )
          : undefined,
      });
    }
    // Close the old items only after the new one shows, so a failed show
    // does not leave the Inbox with no next-action item.
    await Promise.all([
      closeLegacyItems(items, name),
      // The same read closes the merge conflict item from
      // `merge-conflict-checks/policy.ts` when the conflict is gone.
      state.state !== "open" ||
      (state.mergeableState && state.mergeableState !== "dirty")
        ? items.close({
            dedupeKey: gitHubConflictItemKey(target),
            ...(endedReason(state.state) ?? {
              reason: GITHUB_CONFLICT_GONE_REASON,
              status: "done",
            }),
          })
        : undefined,
    ]);
    if (changed && next.action !== "merge" && reason === "handled") {
      await dropGitHubReviewAsked(args.state, target);
    }
    if (!changed) return previous;
    // Save after the items change, so a failure leaves the old action and
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
  return undefined;
}

/** The task that syncs one pull request again after a webhook's sync failed. */
export const GITHUB_PULL_REQUEST_ACTION_SYNC_TASK = "syncPullRequestAction";

const syncTaskPayloadSchema = z
  .object({
    number: z.number().int().positive(),
    repositoryFullName: z.string().min(1),
    /** Tasks that ran before this one and hit the rate limit again. */
    restarts: z.number().int().nonnegative(),
  })
  .strict();

// A rate limit that lasts this many hours stops the restarts.
const MAX_SYNC_TASK_RESTARTS = 3;

// The queue can deliver a task a little before the rate limit resets.
const RATE_LIMIT_RESET_MARGIN_SECONDS = 5;

// A task message is signed when it starts, and the queue rejects a signature
// older than 60 minutes. A task that runs before the reset fails again, and
// the task backoff covers the rest of the hour.
const MAX_SYNC_TASK_DELAY_SECONDS = 55 * 60;

/**
 * Return when to sync again after a failure that GitHub causes for a
 * while: after the GraphQL rate limit resets, or after the task backoff
 * for a GitHub outage. Return undefined for other failures, which a retry
 * cannot fix.
 */
async function retryAfterFailure(
  env: GitHubInstallationEnv,
  target: GitHubPullRequestTarget,
  error: unknown,
): Promise<{ delaySeconds?: number } | undefined> {
  if (error instanceof GitHubGraphqlError) {
    // GitHub sends `RATE_LIMIT`, and its docs name `RATE_LIMITED`.
    if (
      !error.types.some(
        (type) => type === "RATE_LIMIT" || type === "RATE_LIMITED",
      )
    ) {
      // GitHub's own failures, such as a query timeout, have no type.
      return error.types.length === 0 ? {} : undefined;
    }
    // Without the reset time, the task backoff still retries.
    const reset = await loadGraphqlRateLimitReset(
      env,
      target.repositoryFullName,
    ).catch(() => undefined);
    if (!reset) return {};
    const seconds = Math.ceil((reset.getTime() - Date.now()) / 1000);
    return {
      delaySeconds: Math.min(
        Math.max(seconds, 0) + RATE_LIMIT_RESET_MARGIN_SECONDS,
        MAX_SYNC_TASK_DELAY_SECONDS,
      ),
    };
  }
  return error instanceof GitHubRequestError && error.status >= 500
    ? {}
    : undefined;
}

/**
 * Add, change, or close the next-action item of each Junior pull request that
 * a webhook delivery can change. The item is optional, so a failure does not
 * fail the delivery. A failure that GitHub causes for a while starts a task
 * that syncs the pull request again, when `tasks` is given. Other failures
 * are logged. Return the pull requests that another webhook was checking.
 * That webhook checks them again, but without `askAfterRequesterActed`.
 */
export async function syncGitHubPullRequestActions(
  args: PullRequestActionSyncContext & {
    deliveryId: string;
    targets: GitHubPullRequestActionTarget[];
    tasks?: PluginTaskStarter | undefined;
  },
): Promise<GitHubPullRequestActionTarget[]> {
  const busy: GitHubPullRequestActionTarget[] = [];
  await pLimit(PULL_REQUEST_SYNC_CONCURRENCY).map(
    args.targets,
    async (target) => {
      try {
        if ((await syncOne(args, target)) === "busy") busy.push(target);
      } catch (error) {
        const metadata = {
          deliveryId: args.deliveryId,
          number: target.number,
          repository: target.repositoryFullName,
        };
        const retry = args.tasks
          ? await retryAfterFailure(args.env, target, error)
          : undefined;
        if (!args.tasks || !retry) {
          logFailOpenFailure(
            args.log,
            "GitHub pull request action failed",
            error,
            metadata,
          );
          return;
        }
        args.log?.warn(
          "GitHub pull request action failed; retrying in a task",
          {
            ...metadata,
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
        );
        await startSyncTask(args.tasks, target, retry, 0);
      }
    },
  );
  return busy;
}

async function startSyncTask(
  tasks: PluginTaskStarter,
  target: GitHubPullRequestTarget,
  retry: { delaySeconds?: number },
  restarts: number,
): Promise<void> {
  // Failures that start their task in the same minute share it, so a burst
  // of webhooks during a rate limit syncs again once.
  const startsAt = Date.now() + (retry.delaySeconds ?? 0) * 1000;
  await tasks.start({
    ...retry,
    key: `pull-request-action-sync:${itemName(target)}:${Math.floor(startsAt / 60_000)}:${restarts}`,
    name: GITHUB_PULL_REQUEST_ACTION_SYNC_TASK,
    payload: {
      number: target.number,
      repositoryFullName: target.repositoryFullName,
      restarts,
    },
  });
}

/** The sync context of a started task, with fresh installation tokens. */
export function startedTaskSyncContext(
  ctx: PluginStartedTaskContext,
  options: {
    botEmail: string | undefined;
    env: Omit<GitHubInstallationEnv, "responses" | "tokens">;
  },
): PullRequestActionSyncContext {
  return {
    botEmail: options.botEmail,
    codeChanges: ctx.codeChanges,
    db: gitHubDbSchema.parse(ctx.db),
    env: { ...options.env, responses: ctx.state, tokens: new Map() },
    loadGitHubLogin: async (identityId) =>
      linkedGitHubLogin((await ctx.users.readIdentity(identityId))?.user),
    log: ctx.log,
    inboxItems: ctx.inboxItems,
    state: ctx.state,
  };
}

/**
 * Sync the next action of one pull request again. A rate limit starts a new
 * task that waits for the reset: the queue rejects a task message an hour
 * after it starts, so the backoff of this one can end before the reset.
 * Other failures throw, so the task queue runs it again after its backoff,
 * a bounded number of times.
 */
export function githubPullRequestActionSyncTask(options: {
  botEmail: () => string | undefined;
  env: Omit<GitHubInstallationEnv, "responses" | "tokens">;
}): PluginStartedTaskDefinition<typeof syncTaskPayloadSchema> {
  return {
    payload: syncTaskPayloadSchema,
    async run(ctx) {
      const context = startedTaskSyncContext(ctx, {
        botEmail: options.botEmail(),
        env: options.env,
      });
      const { restarts } = ctx.payload;
      try {
        await syncOne(context, ctx.payload);
      } catch (error) {
        const retry = await retryAfterFailure(context.env, ctx.payload, error);
        if (
          retry?.delaySeconds === undefined ||
          restarts >= MAX_SYNC_TASK_RESTARTS
        ) {
          throw error;
        }
        ctx.log.warn(
          "GitHub pull request action sync task hit the rate limit",
          {
            number: ctx.payload.number,
            repository: ctx.payload.repositoryFullName,
            restarts,
          },
        );
        await startSyncTask(ctx.tasks, ctx.payload, retry, restarts + 1);
      }
    },
  };
}
