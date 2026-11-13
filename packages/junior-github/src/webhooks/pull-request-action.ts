/**
 * The next action of a Junior pull request for its requester, and its one
 * item on the review desk.
 *
 * The action derives from GitHub state. It is "merge" when the pull request
 * is open, not a draft, approved, auto-merge is off, and GitHub's merge state
 * is `clean`. Otherwise it is "review" when GitHub still asks the requester
 * for a review. The requester takes one of them, not both, so one item per
 * pull request shows the action. Each webhook that can change one of these
 * facts reads them again from GitHub. Junior saves the derived action and
 * changes the item only when the action changes.
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
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import type { GitHubPullRequestAction } from "../db/schema.js";
import {
  claimGitHubPullRequestReadySync,
  releaseGitHubPullRequestReadySync,
  setGitHubPullRequestNextAction,
} from "../pull-request-outcomes/store.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { checkSuitePullRequests } from "./check-suite.js";
import { logFailOpenFailure } from "./fail-open-log.js";
import {
  loadPullRequestMergeState,
  type GitHubInstallationEnv,
  type GitHubPullRequestMergeState,
} from "./installation-requests.js";
import type { GitHubPullRequestTarget } from "./pull-request-people.js";

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
];

async function closeLegacyItems(
  items: PluginReviewItems,
  name: string,
): Promise<void> {
  for (const prefix of LEGACY_DEDUPE_PREFIXES) {
    await items.close({
      dedupeKey: `${prefix}${name}`,
      reason: "One item now shows the next action.",
      status: "dismissed",
    });
  }
}

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: z.object({ full_name: z.string().min(1) }),
});

/** Return the pull requests whose next action one webhook delivery can change. */
export function pullRequestActionTargets(
  eventName: string,
  body: unknown,
): GitHubPullRequestTarget[] {
  if (eventName === "check_suite") return checkSuitePullRequests(body);
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

/**
 * Derive the requester's next action. Return undefined when it cannot be
 * known yet, so a later event decides.
 */
function nextAction(
  state: GitHubPullRequestMergeState,
  requesterLogin: string | undefined,
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
  const login = requesterLogin?.toLowerCase();
  if (
    login &&
    state.requestedReviewers.some(
      (reviewer) => reviewer.toLowerCase() === login,
    )
  ) {
    return { action: "review" };
  }
  if (canMerge && !state.mergeableState) return undefined;
  return {};
}

function closeReason(
  state: GitHubPullRequestMergeState,
  previous: GitHubPullRequestAction,
): { reason: string; status: "done" | "dismissed" } {
  if (state.state === "merged") {
    return { reason: "The pull request merged.", status: "done" };
  }
  if (state.state === "closed") {
    return {
      reason: "The pull request closed without merging.",
      status: "dismissed",
    };
  }
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
    state: GitHubPullRequestMergeState;
  },
): Promise<void> {
  const { action, number, state } = args;
  if (action) {
    await items.upsert({
      assigneeIdentityIds: [args.identityId],
      // The URL stands alone, so the dashboard shows the pull request as
      // one card that carries its title. The text names it by number only.
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

async function syncOne(
  args: {
    db: GitHubDb;
    env: GitHubInstallationEnv;
    loadGitHubLogin?(identityId: string): Promise<string | undefined>;
    reviewItems: PluginConversationReviewItems;
  },
  target: GitHubPullRequestTarget,
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
  const name = `${target.repositoryFullName}#${target.number}`.toLowerCase();
  const dedupeKey = `pull-request-action:${name}`;
  const requesterLogin = await args.loadGitHubLogin?.(opener.identityId);
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
  while (requests !== undefined) {
    try {
      const state = await loadPullRequestMergeState(args.env, target);
      const next = nextAction(state, requesterLogin, saved);
      // Act only on a change. So repeat events add no second item, and an
      // item that a person closed does not come back until the action
      // changes. When the action cannot be known yet, a later event decides.
      const changed = next !== undefined && next.action !== saved;
      if (changed) {
        await showAction(items, {
          action: next.action,
          dedupeKey,
          identityId: opener.identityId,
          number: target.number,
          previous: saved,
          state,
        });
      }
      await closeLegacyItems(items, name);
      if (changed) {
        // Save after the items change, so a failure leaves the old action
        // and the next event tries again.
        await setGitHubPullRequestNextAction(args.db, {
          ...target,
          action: next.action,
        });
        saved = next.action;
      }
    } catch (error) {
      failure ??= error;
    }
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
  db: GitHubDb;
  deliveryId: string;
  env: GitHubInstallationEnv;
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
  log?: Pick<PluginLogger, "error" | "warn">;
  reviewItems: PluginConversationReviewItems;
  targets: GitHubPullRequestTarget[];
}): Promise<void> {
  for (const target of args.targets) {
    try {
      await syncOne(args, target);
    } catch (error) {
      logFailOpenFailure(args.log, "GitHub pull request action failed", error, {
        deliveryId: args.deliveryId,
        number: target.number,
        repository: target.repositoryFullName,
      });
    }
  }
}
