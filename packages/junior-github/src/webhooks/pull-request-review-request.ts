/**
 * The "review requested" ask on the review desk for a Junior pull request.
 *
 * When GitHub asks the requester for a review on a pull request that they
 * asked Junior to open, the ask goes to the Conversation where they asked.
 * It is assigned to them only when they are in that Conversation, and it
 * waits on them. It closes when they submit a review, when the request is
 * removed, or when the pull request closes. Reopening the pull request adds
 * it again while their request is still open, because GitHub does not send
 * a new request for it. GitHub sends each of these facts in the webhook, so
 * the ask needs no GitHub read and no saved state.
 *
 * Only the requester can get the ask. Junior maps a GitHub login to a person
 * only through the requester's linked GitHub account, and other pull
 * requests have no Conversation for the ask.
 */
import type {
  PluginConversationReviewItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";

const login = z.object({ login: z.string().min(1) });

const pullRequestEventSchema = z.object({
  action: z.enum([
    "closed",
    "reopened",
    "review_request_removed",
    "review_requested",
  ]),
  pull_request: z.object({
    html_url: z.string().url(),
    merged: z.boolean().optional(),
    number: z.number().int().positive(),
    // The people whose review is still requested. Teams are listed apart.
    requested_reviewers: z.array(login).optional(),
    title: z.string(),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
  // A team request has `requested_team` instead.
  requested_reviewer: login.optional(),
});

const reviewEventSchema = z.object({
  action: z.literal("submitted"),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: z.object({ full_name: z.string().min(1) }),
  review: z.object({ user: login }),
});

type ReviewRequestChange =
  | {
      kind: "requested";
      reviewers: string[];
      title: string;
      url: string;
    }
  | {
      kind: "ended";
      reason: string;
      /** Unset when the change ends the ask for every reviewer. */
      reviewer?: string;
      status: "done" | "dismissed";
    };

function reviewRequestChange(
  eventName: string,
  body: unknown,
):
  | { change: ReviewRequestChange; number: number; repository: string }
  | undefined {
  if (eventName === "pull_request_review") {
    const parsed = reviewEventSchema.safeParse(body);
    if (!parsed.success) return undefined;
    return {
      change: {
        kind: "ended",
        reason: "The requester reviewed the pull request.",
        reviewer: parsed.data.review.user.login,
        status: "done",
      },
      number: parsed.data.pull_request.number,
      repository: parsed.data.repository.full_name,
    };
  }
  if (eventName !== "pull_request") return undefined;
  const parsed = pullRequestEventSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { action, pull_request: pull } = parsed.data;
  const reviewer = parsed.data.requested_reviewer?.login;
  const target = {
    number: pull.number,
    repository: parsed.data.repository.full_name,
  };
  if (action === "reopened") {
    const reviewers = (pull.requested_reviewers ?? []).map(
      (person) => person.login,
    );
    if (reviewers.length === 0) return undefined;
    return {
      ...target,
      change: {
        kind: "requested",
        reviewers,
        title: pull.title,
        url: pull.html_url,
      },
    };
  }
  if (action !== "closed" && !reviewer) {
    // A team request names no person, and Junior cannot tell who is on it.
    return undefined;
  }
  if (action === "review_requested" && reviewer) {
    return {
      ...target,
      change: {
        kind: "requested",
        reviewers: [reviewer],
        title: pull.title,
        url: pull.html_url,
      },
    };
  }
  if (action === "review_request_removed") {
    return {
      ...target,
      change: {
        kind: "ended",
        reason: "The review request was removed.",
        reviewer,
        status: "dismissed",
      },
    };
  }
  return {
    ...target,
    change: pull.merged
      ? { kind: "ended", reason: "The pull request merged.", status: "done" }
      : {
          kind: "ended",
          reason: "The pull request closed without merging.",
          status: "dismissed",
        },
  };
}

function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Add or close the "review requested" ask of a Junior pull request when one
 * webhook delivery changes the review request of its requester. The ask is
 * optional, so a failure is logged and does not fail the delivery.
 */
export async function syncGitHubPullRequestReviewRequest(args: {
  body: unknown;
  db: GitHubDb;
  deliveryId: string;
  eventName: string;
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
  log?: Pick<PluginLogger, "error">;
  reviewItems: PluginConversationReviewItems;
}): Promise<void> {
  const parsed = reviewRequestChange(args.eventName, args.body);
  if (!parsed) return;
  const { change, number, repository } = parsed;
  try {
    const opener = (
      await listGitHubPullRequestOpeners(args.db, {
        numbers: [number],
        repositoryFullName: repository,
      })
    ).get(number);
    if (!opener?.conversationId) return;
    const name = `${repository}#${number}`;
    const dedupeKey = `pull-request-review-requested:${name.toLowerCase()}`;
    const items = args.reviewItems.forConversation(opener.conversationId);
    // A change about named reviewers matters only when the requester is one.
    const reviewers =
      change.kind === "requested"
        ? change.reviewers
        : change.reviewer === undefined
          ? undefined
          : [change.reviewer];
    if (reviewers !== undefined) {
      const requesterLogin = await args.loadGitHubLogin?.(opener.identityId);
      if (
        !requesterLogin ||
        !reviewers.some((reviewer) => sameLogin(reviewer, requesterLogin))
      ) {
        return;
      }
    }
    if (change.kind === "ended") {
      await items.close({
        dedupeKey,
        reason: change.reason,
        status: change.status,
      });
      return;
    }
    await items.upsert({
      assigneeIdentityIds: [opener.identityId],
      body: `GitHub asks you to review **${change.title}**: ${change.url}`,
      dedupeKey,
      subject: { id: change.url, title: change.title, url: change.url },
      title: `Review requested · #${number}`,
      waitsOnAssignees: true,
    });
  } catch (error) {
    args.log?.error("GitHub pull request review request failed", {
      deliveryId: args.deliveryId,
      errorType: error instanceof Error ? error.name : "UnknownError",
      number,
      repository,
    });
  }
}
