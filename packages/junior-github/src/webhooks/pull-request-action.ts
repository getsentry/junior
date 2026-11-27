/**
 * The next action of a Junior PR for its requester, and its one `pull_request`
 * Inbox item; `design/github.md` owns the ask rules. Each webhook that can
 * change it reads GitHub again; the saved action shows when it changes. A
 * person joins only with the event that asks them, and only in the requesting
 * Conversation, mapped from GitHub only by linked accounts.
 */
import type {
  ConversationInboxItemChange,
  PluginCache,
  PluginCodeChanges,
  PluginConversationInboxItems,
  PluginLogger,
  PluginStartedTaskContext,
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
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
import { GitHubRequestError } from "../credential-support.js";
import { type GitHubDb, gitHubDbSchema } from "../db/database.js";
import type { GitHubPullRequestAction } from "../db/schema.js";
import {
  inLimbo,
  latestActivity,
  nextAction,
  requesterFeedback,
  sameLogin,
  timeOf,
} from "./pull-request-next-action.js";
import {
  claimGitHubPullRequestReadySync,
  findGitHubPullRequest,
  releaseGitHubPullRequestReadySync,
  setGitHubPullRequestNextAction,
} from "../pull-request-outcomes/store.js";
import { GITHUB_CONFLICT_GONE_REASON } from "../merge-conflict-checks/policy.js";
import {
  listGitHubPullRequestOpeners,
  recordGitHubPullRequestOpenerId,
} from "../pull-request-requesters/store.js";
import {
  dropHeldGitHubReviewAsk,
  type GitHubReviewAskReason,
  markGitHubReviewAsked,
  readGitHubReviewAsked,
  type GitHubReviewAsked,
  readHeldGitHubReviewAsk,
  readGitHubRequiredChecksPass,
  readReviewAgainReadiness,
} from "../pull-request-review-again.js";
import { linkedGitHubLogin } from "../tool-support/attribution.js";
import { checkSuitePullRequests } from "./check-suite.js";
import {
  dropGitHubReviewRequested,
  markGitHubReviewRequested,
  readGitHubReviewRequested,
} from "./review-requests.js";
import { logFailOpenFailure } from "./fail-open-log.js";
import { GitHubGraphqlError } from "./graphql-request.js";
import {
  loadGraphqlRateLimitReset,
  loadPullRequestMergeState,
  loadRepositoryMergeAccess,
  loadReviewAgainReader,
  requestPullRequestReviewers,
  type GitHubInstallationEnv,
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

/** Return the pull requests whose next action one webhook can change. */
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
 * Ask the reviewer of a held review ask again once the required checks pass,
 * and return their login and the reason. Keep the hold until the checks pass
 * and GitHub takes the request. Drop it when the PR ended, the reviewer acted
 * since, or their change request is no longer ready.
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
  requesterLogin: string | undefined,
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
      isRequester: async () => sameLogin(held.reviewer, requesterLogin),
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
 * Return why Junior asked the requester, if it did: the reason of the held
 * ask that this sync released, or the reason of the mark that a Junior tool
 * wrote when it asked them, if they have not acted since.
 */
async function askReason(
  state: PluginState,
  target: GitHubPullRequestTarget,
  args: {
    asked: { reason: GitHubReviewAskReason; reviewer: string } | undefined;
    requesterAt: Date | undefined;
    requesterLogin: string | undefined;
  },
): Promise<
  { mark?: GitHubReviewAsked; reason: GitHubReviewAskReason } | undefined
> {
  if (args.asked !== undefined) {
    return sameLogin(args.asked.reviewer, args.requesterLogin)
      ? { reason: args.asked.reason }
      : undefined;
  }
  const asked = await readGitHubReviewAsked(state, target);
  return asked &&
    sameLogin(asked.reviewer, args.requesterLogin) &&
    timeOf(args.requesterAt) <= Date.parse(asked.at)
    ? { mark: asked, reason: asked.reason ?? "handled" }
    : undefined;
}

/** What one sync of a pull request's items reads and writes. */
interface PullRequestActionSyncContext {
  /**
   * Also ask in limbo when the requester reviewed or commented before the
   * last push. Only the one-off backfill does: pushes do not ask the
   * requester again.
   */
  askAfterRequesterActed?: boolean | undefined;
  botEmail: string | undefined;
  /** Holds the requester's repository access, which decides a merge ask. */
  cache: PluginCache;
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
  if (!opener.pullRequestId) {
    await recordGitHubPullRequestOpenerId(args.db, {
      conversationId: opener.conversationId,
      number: target.number,
      pullRequestId,
      repositoryFullName: target.repositoryFullName,
    });
  }
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
    const asked = await askHeldReview(args, target, state, requesterLogin);
    const ask = await askReason(args.state, target, {
      asked,
      requesterAt: activity.requesterAt,
      requesterLogin,
    });
    const reason = ask?.reason;
    const requester = {
      actedLast: timeOf(activity.requesterAt) > timeOf(activity.askedAt),
      askedAgain: asked !== undefined && reason !== undefined,
      feedback: requesterFeedback(state, activity),
      login: requesterLogin,
    };
    const decide = (mergeAccess: boolean) =>
      nextAction(state, { ...requester, mergeAccess }, previous);
    const withAccess = decide(true);
    // Only a merge ask, new or saved, needs the requester's access, so most
    // syncs read none. Junior knows a requester's access only through their
    // linked GitHub login.
    const mergeAccess =
      withAccess?.action === "merge" || previous === "merge"
        ? requesterLogin !== undefined &&
          (await loadRepositoryMergeAccess(args.env, args.cache, {
            login: requesterLogin,
            repositoryFullName: target.repositoryFullName,
          }))
        : undefined;
    const next = mergeAccess === false ? decide(false) : withAccess;
    if (
      !askedRequester &&
      requesterLogin &&
      next !== undefined &&
      next.action === undefined &&
      inLimbo(state, activity, requesterLogin) &&
      (args.askAfterRequesterActed || activity.actedAt === undefined)
    ) {
      // A pull request in limbo waits for the required checks, as a review
      // ask again does. A later check suite webhook syncs again, and so
      // does a check of this sync again, so only a sent ask counts.
      const [owner = "", name = ""] = target.repositoryFullName.split("/");
      const checksPass = await readGitHubRequiredChecksPass(
        await loadReviewAgainReader(args.env, target.repositoryFullName),
        { name, number: target.number, owner },
      );
      if (checksPass) {
        askedRequester = true;
        // The next read sees the request and shows its item.
        if (await requestReviewAgain(args, target, requesterLogin)) {
          return await check(previous);
        }
      }
    }
    // When the action cannot be known yet, the saved one stays until a
    // later event decides. A new question from Junior is a change too: it
    // can come while the review is already the action, and its mark is
    // dropped once the item shows it. Only a review shows why Junior asked.
    const showsAsk =
      next?.action === "review" || next?.action === "review_draft";
    const changed =
      next !== undefined &&
      (next.action !== previous ||
        (reason === "question" && showsAsk && !ask?.mark?.shown));
    const action = next === undefined ? previous : next.action;
    // The item stays as it is too, because its text depends on what GitHub
    // has not computed yet, such as whether anyone approved.
    if (next !== undefined || previous === undefined) {
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
        mergeAccess,
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
    }
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
    // Mark the ask shown once a review item shows it. A sync that closes
    // the item, such as the one that GitHub's removal of a request starts,
    // leaves it for the review request that follows. The mark stays, so
    // each later sync keeps the item's text until the requester acts.
    if (changed && showsAsk && ask?.mark && !ask.mark.shown) {
      await markGitHubReviewAsked(args.state, target, {
        ...ask.mark,
        shown: true,
      });
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
 * Add, change, or close the item of each Junior pull request that a webhook
 * delivery can change. The item is optional, so failures are logged, and one
 * that GitHub causes for a while starts a sync task when `tasks` is given.
 * Return the pull requests that another webhook was checking, which it checks
 * again without `askAfterRequesterActed`.
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
    key: `pull-request-action-sync:${`${target.repositoryFullName}#${target.number}`.toLowerCase()}:${Math.floor(startsAt / 60_000)}:${restarts}`,
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
    cache: ctx.cache,
    codeChanges: ctx.codeChanges,
    db: gitHubDbSchema.parse(ctx.db),
    env: { ...options.env, responses: ctx.state, tokens: new Map() },
    findLinkedIdentityIds: async (logins) =>
      await ctx.users.findLinkedIdentityIds(logins),
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
