/**
 * The next action of a Junior pull request for its requester, and its one
 * item in the Inbox.
 *
 * The action derives from GitHub state. It is "merge" when the pull request
 * is open, not a draft, approved, auto-merge is off, and GitHub's merge state
 * is `clean`. Otherwise it is "review" when GitHub still asks the requester
 * for a review, or when the requester's latest review requests changes and
 * Junior acted after the requester: it pushed, its App commented or
 * reviewed, or GitHub asked for the requester's review again. GitHub stops
 * asking a reviewer once they review, so without the second case a fixed or
 * answered pull request never asks the requester again. Then Junior also
 * asks for their review on GitHub, so GitHub notifies them. When the
 * requester comments or reviews after that, the action ends, even while
 * GitHub still asks them, because Junior acts next. Junior saves the time
 * of each side's latest activity from the webhooks, so a comment needs no
 * GitHub read to know who acted last.
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
  PluginConversationReviewItems,
  PluginLogger,
  PluginReviewItems,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import type { GitHubPullRequestAction } from "../db/schema.js";
import {
  claimGitHubPullRequestReadySync,
  readGitHubPullRequestActivity,
  releaseGitHubPullRequestReadySync,
  setGitHubPullRequestNextAction,
  type GitHubPullRequestActorActivity,
} from "../pull-request-outcomes/store.js";
import {
  GITHUB_CONFLICT_GONE_REASON,
  gitHubConflictItemKey,
} from "../merge-conflict-checks/policy.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { checkSuitePullRequests } from "./check-suite.js";
import { logFailOpenFailure } from "./fail-open-log.js";
import {
  loadPullRequestMergeState,
  requestPullRequestReviewers,
  type GitHubInstallationEnv,
  type GitHubPullRequestMergeState,
} from "./installation-requests.js";
import { isBotLogin } from "./ownership.js";
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
  items: PluginReviewItems,
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

/**
 * What one webhook says that a person or Junior did on a pull request:
 * `author` wrote a comment or review, `push` pushed commits, and
 * `reviewRequest` is a new request for the review of `login`.
 */
interface WebhookActivity {
  at: Date;
  kind: "author" | "push" | "reviewRequest";
  login: string;
}

/** A pull request whose next action one webhook delivery can change. */
export interface GitHubPullRequestActionTarget extends GitHubPullRequestTarget {
  activity?: WebhookActivity;
  /**
   * A comment changes the next action only when Junior or the requester
   * wrote it, so the check skips comments by other people.
   */
  activityOnly?: true;
}

const timestampSchema = z.iso.datetime({ offset: true });
const loginSchema = z.object({ login: z.string().min(1) });
const repositorySchema = z.object({ full_name: z.string().min(1) });

// GitHub sends null for a team review request's `requested_reviewer` and
// for a deleted account, so the activity fields accept null.
const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    updated_at: timestampSchema.nullish(),
  }),
  repository: repositorySchema,
  requested_reviewer: loginSchema.nullish(),
  review: z
    .object({
      submitted_at: timestampSchema.nullish(),
      user: loginSchema.nullish(),
    })
    .nullish(),
  sender: loginSchema.nullish(),
});

// The comment webhooks that a person or Junior's App sends by commenting
// on a pull request. Only a pull request's issue carries `pull_request`.
const commentWebhookSchema = z.object({
  action: z.literal("created"),
  comment: z.object({
    created_at: timestampSchema,
    user: loginSchema.nullish(),
  }),
  issue: z
    .object({ number: z.number().int().positive(), pull_request: z.object({}) })
    .optional(),
  pull_request: z.object({ number: z.number().int().positive() }).optional(),
  repository: repositorySchema,
});

function pullRequestActivity(
  event: z.output<typeof pullRequestWebhookSchema>,
): WebhookActivity | undefined {
  const updatedAt = event.pull_request.updated_at;
  if (event.action === "synchronize" && updatedAt && event.sender) {
    return {
      at: new Date(updatedAt),
      kind: "push",
      login: event.sender.login,
    };
  }
  if (
    event.action === "review_requested" &&
    updatedAt &&
    event.requested_reviewer
  ) {
    return {
      at: new Date(updatedAt),
      kind: "reviewRequest",
      login: event.requested_reviewer.login,
    };
  }
  if (
    event.action === "submitted" &&
    event.review?.submitted_at &&
    event.review.user
  ) {
    return {
      at: new Date(event.review.submitted_at),
      kind: "author",
      login: event.review.user.login,
    };
  }
  return undefined;
}

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
    // A comment by a deleted account is by neither Junior nor the requester.
    if (number === undefined || !comment.user) return [];
    return [
      {
        activity: {
          at: new Date(comment.created_at),
          kind: "author",
          login: comment.user.login,
        },
        activityOnly: true,
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
  const activity = pullRequestActivity(parsed.data);
  return [
    {
      ...(activity ? { activity } : undefined),
      number: parsed.data.pull_request.number,
      repositoryFullName: parsed.data.repository.full_name,
    },
  ];
}

/**
 * Whose activity a webhook reports. A push counts as Junior's, as new
 * commits do. A new request for the requester's review hands the pull
 * request to them, so it counts as Junior's too.
 */
function actorActivity(
  activity: WebhookActivity | undefined,
  requesterLogin: string | undefined,
  botEmail: string | undefined,
): GitHubPullRequestActorActivity | undefined {
  if (!activity) return undefined;
  const byRequester =
    requesterLogin !== undefined &&
    activity.login.toLowerCase() === requesterLogin.toLowerCase();
  const { at } = activity;
  switch (activity.kind) {
    case "push":
      return { at, by: "junior" };
    case "reviewRequest":
      return byRequester ? { at, by: "junior" } : undefined;
    case "author":
      if (isBotLogin(activity.login, botEmail)) return { at, by: "junior" };
      return byRequester ? { at, by: "requester" } : undefined;
  }
}

/** When Junior and the requester last acted on a pull request. */
interface SavedActivity {
  juniorAt?: Date;
  requesterAt?: Date;
}

// A missing time is older than every time.
function timeOf(at: Date | undefined): number {
  return at ? at.getTime() : Number.NEGATIVE_INFINITY;
}

/** Why the requester's review is wanted again after their change request. */
type ReviewAgainReason = "commits" | "reply";

/**
 * Return why the requester's review is wanted again after their change
 * request, or undefined while Junior acts next.
 */
function reviewAgainReason(
  state: GitHubPullRequestMergeState,
  activity: SavedActivity,
): ReviewAgainReason | undefined {
  if (!state.changesRequestedCommit) return undefined;
  const newCommits = state.changesRequestedCommit !== state.headSha;
  const changesRequestedAt = timeOf(state.changesRequestedAt);
  const requesterAt = Math.max(
    timeOf(activity.requesterAt),
    changesRequestedAt,
  );
  if (timeOf(activity.juniorAt) > requesterAt) {
    return newCommits ? "commits" : "reply";
  }
  // A push from before Junior saved activity has no saved time. New commits
  // with no later requester activity still count as Junior's.
  return newCommits && !(timeOf(activity.requesterAt) > changesRequestedAt)
    ? "commits"
    : undefined;
}

/**
 * Derive the requester's next action. Return undefined when it cannot be
 * known yet, so a later event decides.
 */
function nextAction(
  state: GitHubPullRequestMergeState,
  requester: {
    activity: SavedActivity;
    actedLast: boolean;
    login: string | undefined;
  },
  saved: GitHubPullRequestAction | undefined,
):
  | { action?: GitHubPullRequestAction; reason?: ReviewAgainReason }
  | undefined {
  if (state.state !== "open") return {};
  // With auto-merge on, GitHub merges it, so no person needs to.
  const canMerge = !state.draft && !state.autoMerge;
  if (canMerge && state.mergeableState === "clean" && state.approved) {
    return { action: "merge" };
  }
  // GitHub has not computed the merge state yet, such as after a push. The
  // merge can still be the action, so it stays until a later event decides.
  if (canMerge && !state.mergeableState && saved === "merge") return undefined;
  const reason = reviewAgainReason(state, requester.activity);
  if (reason) return { action: "review", reason };
  // A reply to the change request ends the review that Junior asked for,
  // though GitHub still asks for it, because Junior acts next.
  const replied = state.changesRequestedCommit && requester.actedLast;
  if (isRequested(state, requester.login) && !replied) {
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

const REVIEW_AGAIN_TEXT: Record<ReviewAgainReason, (number: number) => string> =
  {
    commits: (number) =>
      `#${number} has new commits since you requested changes.`,
    reply: (number) => `#${number} has a reply since you requested changes.`,
  };

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
  items: PluginReviewItems,
  args: {
    action: GitHubPullRequestAction | undefined;
    dedupeKey: string;
    identityId: string;
    number: number;
    previous: GitHubPullRequestAction | undefined;
    reason: ReviewAgainReason | undefined;
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
          : `${args.reason ? REVIEW_AGAIN_TEXT[args.reason](number) : `GitHub asks you to review #${number}.`}\n\n${state.url}`,
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
  reviewItems: PluginConversationReviewItems;
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
    const items = args.reviewItems.forConversation(opener.conversationId);
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
 * Ask for the requester's review on GitHub, so GitHub notifies them. The
 * item already asks, so a failure is logged and the item stays.
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

async function syncOne(
  args: {
    botEmail: string | undefined;
    db: GitHubDb;
    env: GitHubInstallationEnv;
    loadGitHubLogin?:
      | ((identityId: string) => Promise<string | undefined>)
      | undefined;
    log?: Pick<PluginLogger, "error" | "warn"> | undefined;
    reviewItems: PluginConversationReviewItems;
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
  const items = args.reviewItems.forConversation(opener.conversationId);
  const name = itemName(target);
  const dedupeKey = actionDedupeKey(target);
  const requesterLogin = await args.loadGitHubLogin?.(opener.identityId);
  const activity = actorActivity(
    target.activity,
    requesterLogin,
    args.botEmail,
  );
  if (target.activityOnly && !activity) return;
  // One webhook at a time checks a pull request. A webhook that arrives
  // during a check asks again, and the running webhook checks once more with
  // a new GitHub read. No connection or lock stays open during the calls.
  const claim = await claimGitHubPullRequestReadySync(args.db, target, {
    activity,
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
    const saved = await readGitHubPullRequestActivity(args.db, target);
    const actedLast = timeOf(saved.requesterAt) > timeOf(saved.juniorAt);
    const state = await loadPullRequestMergeState(args.env, target, {
      login: requesterLogin,
      requesterActedLast: actedLast,
    });
    const next = nextAction(
      state,
      { activity: saved, actedLast, login: requesterLogin },
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
        reason: next.reason,
        state,
      });
      if (
        next.reason &&
        requesterLogin &&
        !isRequested(state, requesterLogin)
      ) {
        await requestReviewAgain(args, target, requesterLogin);
      }
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
  reviewItems: PluginConversationReviewItems;
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
