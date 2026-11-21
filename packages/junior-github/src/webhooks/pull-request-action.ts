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
 * reviewer after the hold drops it, because Junior acts next. One GitHub
 * read gives the state and each side's latest activity. A comment by
 * another person needs no read.
 *
 * The requester takes one action, not both, so one item per pull request
 * shows it. Each webhook that can change one of these facts reads them
 * again from GitHub. Junior saves the derived action and changes the item
 * only when the action changes.
 *
 * The item goes to the Conversation where a person asked Junior to open the
 * pull request. It is assigned to that person only when they are in that
 * Conversation, and it waits on them. Junior maps a GitHub login to a person
 * only through the requester's linked GitHub account.
 */
import type {
  PluginConversationInboxItems,
  PluginLogger,
  PluginInboxItems,
  PluginState,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import type { GitHubPullRequestAction } from "../db/schema.js";
import {
  claimGitHubPullRequestReadySync,
  releaseGitHubPullRequestReadySync,
  setGitHubPullRequestNextAction,
} from "../pull-request-outcomes/store.js";
import {
  GITHUB_CONFLICT_GONE_REASON,
  gitHubConflictItemKey,
} from "../merge-conflict-checks/policy.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import {
  dropHeldGitHubReviewAsk,
  readHeldGitHubReviewAsk,
  readReviewAgainReadiness,
} from "../pull-request-review-again.js";
import { checkSuitePullRequests } from "./check-suite.js";
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
  if (previous === "review") {
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

async function showAction(
  items: PluginInboxItems,
  args: {
    action: GitHubPullRequestAction | undefined;
    dedupeKey: string;
    identityId: string;
    number: number;
    previous: GitHubPullRequestAction | undefined;
    state: GitHubPullRequestMergeState;
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
      body:
        action === "merge"
          ? `#${number} is approved, and GitHub says that it can merge.\n\n${state.url}`
          : `GitHub asks you to review #${number}.\n\n${state.url}`,
      dedupeKey: args.dedupeKey,
      // The number stays visible where a view shows only the subject.
      subject: {
        id: state.url,
        title: `${state.title} (#${number})`,
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
 * Close the next-action item and the merge conflict notice of a pull request
 * that merged or closed. The outcome write calls this before it marks the
 * chips, so no reader sees an ended pull request next to its open item. The
 * items are optional, so a failure is logged. In a webhook, the next-action
 * sync after it closes the item again.
 */
export async function closeEndedGitHubPullRequestItems(args: {
  db: GitHubDb;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  inboxItems: PluginConversationInboxItems;
  state: EndedState;
  target: GitHubPullRequestTarget;
}): Promise<void> {
  const { target } = args;
  try {
    const opener = (
      await listGitHubPullRequestOpeners(args.db, {
        numbers: [target.number],
        repositoryFullName: target.repositoryFullName,
      })
    ).get(target.number);
    if (!opener?.conversationId) return;
    const items = args.inboxItems.forConversation(opener.conversationId);
    const reason = ENDED_REASONS[args.state];
    await Promise.all([
      items.close({ dedupeKey: actionDedupeKey(target), ...reason }),
      items.close({ dedupeKey: gitHubConflictItemKey(target), ...reason }),
    ]);
  } catch (error) {
    logFailOpenFailure(
      args.log,
      "GitHub ended pull request item close failed",
      error,
      { number: target.number, repository: target.repositoryFullName },
    );
  }
}

/**
 * Ask for a reviewer's review on GitHub, so GitHub notifies them. The item
 * already asks, so a failure is logged and the item stays.
 */
async function requestReviewAgain(
  args: {
    env: GitHubInstallationEnv;
    log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  },
  target: GitHubPullRequestTarget,
  login: string,
): Promise<void> {
  try {
    await requestPullRequestReviewers(args.env, {
      ...target,
      reviewers: [login],
    });
  } catch (error) {
    logFailOpenFailure(args.log, "GitHub review request again failed", error, {
      number: target.number,
      repository: target.repositoryFullName,
    });
  }
}

/**
 * Ask the reviewer of a held review ask again once the required checks
 * pass, and return their login. Keep the hold while the checks have not
 * passed. Drop it when the pull request ended, when the reviewer commented
 * or reviewed since, or when their change request is no longer ready.
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
): Promise<string | undefined> {
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
    { botUserId, name, number: target.number, owner, reviewer: held.reviewer },
  );
  if (readiness === "checks") return undefined;
  await dropHeldGitHubReviewAsk(args.state, target);
  if (readiness !== "ready") return undefined;
  await requestReviewAgain(args, target, held.reviewer);
  return held.reviewer;
}

async function syncOne(
  args: {
    botEmail: string | undefined;
    db: GitHubDb;
    env: GitHubInstallationEnv;
    loadGitHubLogin?:
      | ((identityId: string) => Promise<string | undefined>)
      | undefined;
    log?: Pick<PluginLogger, "error" | "warn"> | undefined;
    inboxItems: PluginConversationInboxItems;
    state: PluginState;
  },
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
  const name = itemName(target);
  const dedupeKey = actionDedupeKey(target);
  const requesterLogin = await args.loadGitHubLogin?.(opener.identityId);
  if (
    target.commentBy !== undefined &&
    !sameLogin(target.commentBy, requesterLogin)
  ) {
    return;
  }
  // One webhook at a time checks a pull request. A webhook that arrives
  // during a check asks again, and the running webhook checks once more with
  // a new GitHub read. No connection or lock stays open during the calls.
  const claim = await claimGitHubPullRequestReadySync(args.db, target, {
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
    const next = nextAction(
      state,
      {
        actedLast: timeOf(activity.requesterAt) > timeOf(activity.askedAt),
        askedAgain: asked !== undefined && sameLogin(asked, requesterLogin),
        login: requesterLogin,
      },
      previous,
    );
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
        state,
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
    if (!changed) return previous;
    // Save after the items change, so a failure leaves the old action and
    // the next event tries again.
    await setGitHubPullRequestNextAction(args.db, {
      ...target,
      action: next.action,
    });
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
    requests = await releaseGitHubPullRequestReadySync(args.db, target, {
      id,
      requests,
    });
  }
  if (failure !== undefined) throw failure;
}

/**
 * Add, change, or close the next-action item of each Junior pull request that
 * a webhook delivery can change. The item is optional, so a failure is logged
 * and does not fail the delivery.
 */
export async function syncGitHubPullRequestActions(args: {
  botEmail: string | undefined;
  db: GitHubDb;
  deliveryId: string;
  env: GitHubInstallationEnv;
  loadGitHubLogin?:
    | ((identityId: string) => Promise<string | undefined>)
    | undefined;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  inboxItems: PluginConversationInboxItems;
  /** Holds the review asks that wait for the required checks. */
  state: PluginState;
  targets: GitHubPullRequestActionTarget[];
}): Promise<void> {
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
