/**
 * Webhook facts that decide whether a Junior pull request needs fixes, for
 * Needs attention. A pull request needs fixes while a check suite on its
 * head commit failed, or while a reviewer requests changes with no push
 * since. A push starts over: it is the answer to both.
 */
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  type GitHubPullRequestAttentionChange,
  recordGitHubPullRequestAttention,
} from "../pull-request-outcomes/store.js";

type AttentionUpdate = {
  change: GitHubPullRequestAttentionChange;
  target: { number: number; repositoryFullName: string };
};

const repositorySchema = z
  .object({ full_name: z.string().min(1), id: z.number() })
  .passthrough();

const pushSchema = z.object({
  action: z.literal("synchronize"),
  pull_request: z.object({
    head: z.object({ sha: z.string().min(1) }).passthrough(),
    number: z.number().int().positive(),
    updated_at: z.string().datetime({ offset: true }),
  }),
  repository: repositorySchema,
});

const checkSuiteSchema = z.object({
  action: z.literal("completed"),
  check_suite: z.object({
    conclusion: z.string().nullable().optional(),
    head_sha: z.string().min(1),
    id: z.number(),
    pull_requests: z.array(
      z
        .object({
          base: z.object({ repo: z.object({ id: z.number() }).passthrough() }),
          number: z.number().int().positive(),
        })
        .passthrough(),
    ),
  }),
  repository: repositorySchema,
});

const reviewSchema = z.object({
  action: z.enum(["dismissed", "submitted"]),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: repositorySchema,
  review: z.object({
    state: z.string(),
    user: z.object({ login: z.string().min(1) }).passthrough(),
  }),
});

/** Suite conclusions that end a failure. Others, such as `cancelled`, keep it. */
const PASSING_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out"]);

function attentionUpdates(eventName: string, body: unknown): AttentionUpdate[] {
  if (eventName === "pull_request") {
    const push = pushSchema.safeParse(body);
    if (!push.success) return [];
    return [
      {
        change: {
          headSha: push.data.pull_request.head.sha,
          kind: "push",
          pushedAt: new Date(push.data.pull_request.updated_at),
        },
        target: {
          number: push.data.pull_request.number,
          repositoryFullName: push.data.repository.full_name,
        },
      },
    ];
  }
  if (eventName === "check_suite") {
    const parsed = checkSuiteSchema.safeParse(body);
    if (!parsed.success) return [];
    const { check_suite: suite, repository } = parsed.data;
    const conclusion = suite.conclusion ?? "";
    const failed = FAILING_CONCLUSIONS.has(conclusion);
    if (!failed && !PASSING_CONCLUSIONS.has(conclusion)) return [];
    // GitHub also lists pull requests from forks with the same head commit.
    return suite.pull_requests
      .filter((pullRequest) => pullRequest.base.repo.id === repository.id)
      .map((pullRequest) => ({
        change: {
          checkSuiteId: String(suite.id),
          failed,
          headSha: suite.head_sha,
          kind: "check_suite" as const,
        },
        target: {
          number: pullRequest.number,
          repositoryFullName: repository.full_name,
        },
      }));
  }
  if (eventName === "pull_request_review") {
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) return [];
    const { action, review } = parsed.data;
    const state = review.state.toLowerCase();
    // A dismissal removes the reviewer's change request. A comment changes
    // nothing.
    if (
      action === "submitted" &&
      state !== "approved" &&
      state !== "changes_requested"
    ) {
      return [];
    }
    return [
      {
        change: {
          changesRequested:
            action === "submitted" && state === "changes_requested",
          kind: "review",
          login: review.user.login,
        },
        target: {
          number: parsed.data.pull_request.number,
          repositoryFullName: parsed.data.repository.full_name,
        },
      },
    ];
  }
  return [];
}

/** Save the "needs fixes" changes that one webhook delivery carries. */
export async function recordGitHubPullRequestAttentionFromWebhook(
  db: GitHubDb,
  eventName: string,
  body: unknown,
): Promise<void> {
  for (const { change, target } of attentionUpdates(eventName, body)) {
    await recordGitHubPullRequestAttention(db, target, change);
  }
}
