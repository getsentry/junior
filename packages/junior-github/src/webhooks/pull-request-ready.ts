/**
 * The "ready to merge" notice on the review desk for a Junior pull request.
 *
 * A pull request is ready to merge when it is open, not a draft, approved,
 * and GitHub's merge state is `clean`. With auto-merge on, GitHub merges it,
 * so no person needs the notice. Each webhook that can change one of
 * these facts reads them again from GitHub. The notice goes to the
 * Conversation where a person asked Junior to open the pull request. It is
 * assigned to that person only when they are in that Conversation, and it
 * waits on them: the merge is their step. It closes when the pull request
 * merges, closes, or is no longer ready. It replaces the requester's
 * "review requested" ask, so it closes that ask.
 */
import type {
  PluginConversationReviewItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  claimGitHubPullRequestReadySync,
  releaseGitHubPullRequestReadySync,
  setGitHubPullRequestReadyToMerge,
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
import {
  READY_REASON,
  reviewRequestDedupeKey,
} from "./pull-request-review-request.js";

/**
 * A check normally takes a few seconds. After this time, a check that
 * stopped without its release no longer blocks new checks.
 */
const READY_SYNC_STALE_MS = 60_000;

/** Webhook actions that can change whether a pull request is ready. */
const READY_ACTIONS: Record<string, ReadonlySet<string>> = {
  pull_request: new Set([
    "auto_merge_disabled",
    "auto_merge_enabled",
    "closed",
    "converted_to_draft",
    "ready_for_review",
    "reopened",
    "synchronize",
  ]),
  pull_request_review: new Set(["dismissed", "submitted"]),
};

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: z.object({ full_name: z.string().min(1) }),
});

/** Return the pull requests whose readiness one webhook delivery can change. */
export function pullRequestReadyTargets(
  eventName: string,
  body: unknown,
): GitHubPullRequestTarget[] {
  if (eventName === "check_suite") return checkSuitePullRequests(body);
  const actions = READY_ACTIONS[eventName];
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

function closeReason(state: GitHubPullRequestMergeState): {
  reason: string;
  status: "done" | "dismissed";
} {
  if (state.state === "merged") {
    return { reason: "The pull request merged.", status: "done" };
  }
  if (state.state === "closed") {
    return {
      reason: "The pull request closed without merging.",
      status: "dismissed",
    };
  }
  if (state.autoMerge) {
    return { reason: "Auto-merge is on.", status: "dismissed" };
  }
  return {
    reason: "The pull request is no longer ready to merge.",
    status: "dismissed",
  };
}

async function syncOne(
  args: {
    db: GitHubDb;
    env: GitHubInstallationEnv;
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
  // and a Conversation for the notice.
  if (!opener?.conversationId) return;
  const items = args.reviewItems.forConversation(opener.conversationId);
  const name = `${target.repositoryFullName}#${target.number}`;
  const dedupeKey = `pull-request-ready:${name.toLowerCase()}`;
  // One webhook at a time checks a pull request. A webhook that arrives
  // during a check asks again, and the running webhook checks once more with
  // a new GitHub read. No connection or lock stays open during the calls.
  const claim = await claimGitHubPullRequestReadySync(args.db, target, {
    now: new Date(),
    staleMs: READY_SYNC_STALE_MS,
  });
  if (!claim) return;
  const { id } = claim;
  let saved = claim.ready;
  let requests: number | undefined = claim.requests;
  // A failed check still checks the requests that came in during it. The
  // first failure is thrown after the last check.
  let failure: unknown;
  while (requests !== undefined) {
    try {
      const state = await loadPullRequestMergeState(args.env, target);
      const open = state.state === "open" && !state.draft;
      const ready =
        open &&
        !state.autoMerge &&
        state.mergeableState === "clean" &&
        state.approved;
      // Act only on a change. So repeat events add no second notice, and a
      // notice that a person closed does not come back until the pull
      // request is ready again. When GitHub has not computed the merge state
      // yet, nothing changes, and a later event decides.
      if (
        (!open || state.autoMerge || state.mergeableState) &&
        ready !== saved
      ) {
        if (ready) {
          await items.upsert({
            assigneeIdentityIds: [opener.identityId],
            body: `**${state.title}** is approved, and GitHub says that it can merge: ${state.url}`,
            dedupeKey,
            // The number stays visible where a view shows only the subject.
            subject: {
              id: state.url,
              title: `${state.title} (#${target.number})`,
              url: state.url,
            },
            title: `Ready to merge · #${target.number}`,
            waitsOnAssignees: true,
          });
        } else {
          await items.close({ dedupeKey, ...closeReason(state) });
        }
        // Save after the notice changes, so a failure leaves the old state
        // and the next event tries again.
        await setGitHubPullRequestReadyToMerge(args.db, { ...target, ready });
        saved = ready;
        // Close the review ask after the save. A review request that adds
        // the ask during this check then reads the ready state and closes it.
        if (ready) {
          await items.close({
            dedupeKey: reviewRequestDedupeKey(target),
            reason: READY_REASON,
            status: "dismissed",
          });
        }
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
 * Add or close the "ready to merge" notice of each Junior pull request that a
 * webhook delivery can change. The notice is optional, so a failure is logged
 * and does not fail the delivery.
 */
export async function syncGitHubPullRequestReadyNotices(args: {
  db: GitHubDb;
  deliveryId: string;
  env: GitHubInstallationEnv;
  log?: Pick<PluginLogger, "error" | "warn">;
  reviewItems: PluginConversationReviewItems;
  targets: GitHubPullRequestTarget[];
}): Promise<void> {
  for (const target of args.targets) {
    try {
      await syncOne(args, target);
    } catch (error) {
      logFailOpenFailure(
        args.log,
        "GitHub pull request ready notice failed",
        error,
        {
          deliveryId: args.deliveryId,
          number: target.number,
          repository: target.repositoryFullName,
        },
      );
    }
  }
}
