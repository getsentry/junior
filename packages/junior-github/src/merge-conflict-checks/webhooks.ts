/**
 * Webhook input for merge conflict checks. These writes make no GitHub API
 * calls, so a busy base branch costs only database writes.
 */
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  markGitHubConflictChecks,
  recordGitHubPullRequestBaseBranch,
} from "./store.js";

/**
 * Time from a push to its check. GitHub calculates mergeability after a
 * push, and pushes in this time share one check.
 */
export const CONFLICT_CHECK_DELAY_MS = 2 * 60_000;

const BRANCH_REF_PREFIX = "refs/heads/";

const pushSchema = z.object({
  deleted: z.boolean().optional(),
  ref: z.string(),
  repository: z.object({ full_name: z.string().min(1) }),
});

const pullRequestBaseSchema = z.object({
  pull_request: z.object({
    base: z.object({ ref: z.string().min(1) }),
    id: z.number().int().positive(),
  }),
});

/**
 * Mark the open Junior pull requests whose base branch got this push. Return
 * the number of marked pull requests.
 */
export async function markGitHubPushConflictChecks(args: {
  body: unknown;
  db: GitHubDb;
  now: Date;
}): Promise<number> {
  const parsed = pushSchema.safeParse(args.body);
  if (
    !parsed.success ||
    parsed.data.deleted ||
    !parsed.data.ref.startsWith(BRANCH_REF_PREFIX)
  ) {
    return 0;
  }
  return await markGitHubConflictChecks(args.db, {
    baseBranch: parsed.data.ref.slice(BRANCH_REF_PREFIX.length),
    dueAt: new Date(args.now.getTime() + CONFLICT_CHECK_DELAY_MS),
    repositoryFullName: parsed.data.repository.full_name,
  });
}

/**
 * Save the base branch from a `pull_request` webhook. Each action sends it,
 * so a changed base and a pull request from before this column both update.
 */
export async function recordGitHubPullRequestWebhookBaseBranch(args: {
  body: unknown;
  db: GitHubDb;
}): Promise<void> {
  const parsed = pullRequestBaseSchema.safeParse(args.body);
  if (!parsed.success) return;
  await recordGitHubPullRequestBaseBranch(args.db, {
    baseBranch: parsed.data.pull_request.base.ref,
    pullRequestId: String(parsed.data.pull_request.id),
  });
}
