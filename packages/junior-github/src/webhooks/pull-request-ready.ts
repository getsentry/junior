/**
 * The "ready to merge" notice on the review desk for a Junior pull request.
 *
 * A pull request is ready to merge when it is open, not a draft, approved,
 * and GitHub's merge state is `clean`. Each webhook that can change one of
 * these facts reads them again from GitHub. The notice goes to the person
 * who asked Junior to open the pull request, in the Conversation where they
 * asked. It closes when the pull request merges, closes, or is no longer
 * ready.
 */
import type {
  PluginConversationReviewItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import { markGitHubPullRequestReadyToMerge } from "../pull-request-outcomes/store.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { checkSuitePullRequests } from "./check-suite.js";
import {
  loadPullRequestMergeState,
  type GitHubInstallationEnv,
  type GitHubPullRequestMergeState,
} from "./installation-requests.js";
import type { GitHubPullRequestTarget } from "./pull-request-people.js";

/** Webhook actions that can change whether a pull request is ready. */
const READY_ACTIONS: Record<string, ReadonlySet<string>> = {
  pull_request: new Set([
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
  const state = await loadPullRequestMergeState(args.env, target);
  const open = state.state === "open" && !state.draft;
  // GitHub has not computed the merge state yet. A later event decides.
  if (open && !state.mergeableState) return;
  const ready = open && state.mergeableState === "clean" && state.approved;
  // Only the call that changes the saved state acts. So repeat events add
  // no second notice, and a notice that a person closed does not come back
  // until the pull request is ready again.
  if (
    !(await markGitHubPullRequestReadyToMerge(args.db, { ...target, ready }))
  ) {
    return;
  }
  const items = args.reviewItems.forConversation(opener.conversationId);
  const name = `${target.repositoryFullName}#${target.number}`;
  const dedupeKey = `pull-request-ready:${name.toLowerCase()}`;
  try {
    if (ready) {
      await items.upsert({
        assigneeIdentityIds: [opener.identityId],
        body: `**${state.title}** is approved, and GitHub says that it can merge. Merge it, or say why not: ${state.url}`,
        dedupeKey,
        subject: { id: state.url, title: name, url: state.url },
        title: `Ready to merge: ${name}`,
      });
    } else {
      await items.close({ dedupeKey, ...closeReason(state) });
    }
  } catch (error) {
    // Undo the saved state, so the next event tries again.
    await markGitHubPullRequestReadyToMerge(args.db, {
      ...target,
      ready: !ready,
    });
    throw error;
  }
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
  log?: Pick<PluginLogger, "error">;
  reviewItems: PluginConversationReviewItems;
  targets: GitHubPullRequestTarget[];
}): Promise<void> {
  for (const target of args.targets) {
    try {
      await syncOne(args, target);
    } catch (error) {
      args.log?.error("GitHub pull request ready notice failed", {
        deliveryId: args.deliveryId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        number: target.number,
        repository: target.repositoryFullName,
      });
    }
  }
}
