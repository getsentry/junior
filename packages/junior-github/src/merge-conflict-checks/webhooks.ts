/**
 * The `push` webhook part of merge conflict checks. It makes no GitHub API
 * calls, so a busy default branch costs only database writes.
 */
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { scheduleGitHubConflictCheck } from "./store.js";

/**
 * Time from a push to its check. GitHub calculates mergeability after a
 * push, and pushes in this time share one check.
 */
export const CONFLICT_CHECK_DELAY_MS = 2 * 60_000;

const pushSchema = z.object({
  deleted: z.boolean().optional(),
  ref: z.string(),
  repository: z.object({
    default_branch: z.string().min(1),
    full_name: z.string().min(1),
  }),
});

/**
 * Schedule a check after a push to a repository's default branch. Stacked
 * pull requests do not need this, because Junior restacks them when it
 * pushes the branch below. Return whether a check waits.
 */
export async function scheduleGitHubPushConflictCheck(args: {
  body: unknown;
  db: GitHubDb;
  now: Date;
}): Promise<boolean> {
  const parsed = pushSchema.safeParse(args.body);
  if (
    !parsed.success ||
    parsed.data.deleted ||
    parsed.data.ref !== `refs/heads/${parsed.data.repository.default_branch}`
  ) {
    return false;
  }
  return await scheduleGitHubConflictCheck(args.db, {
    dueAt: new Date(args.now.getTime() + CONFLICT_CHECK_DELAY_MS),
    repositoryFullName: parsed.data.repository.full_name,
  });
}
