/**
 * Merge conflict checks that wait for the heartbeat.
 *
 * A push to a base branch marks the open Junior pull requests on that branch.
 * The push webhook only writes rows. The heartbeat reads GitHub later, so a
 * burst of pushes gives one read per pull request, and GitHub has time to
 * calculate mergeability.
 */
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";

/** One claimed check. `claimedUntil` identifies the claim. */
export interface GitHubConflictCheck {
  attempts: number;
  claimedUntil: Date;
  number: number;
  pullRequestId: string;
  repositoryFullName: string;
}

/** Save the base branch of a Junior pull request when it changed. */
export async function recordGitHubPullRequestBaseBranch(
  db: GitHubDb,
  input: { baseBranch: string; pullRequestId: string },
): Promise<void> {
  const t = juniorGitHubPullRequests;
  await db
    .update(t)
    .set({ baseBranch: input.baseBranch })
    .where(
      and(
        eq(t.pullRequestId, input.pullRequestId),
        sql`${t.baseBranch} is distinct from ${input.baseBranch}`,
      ),
    );
}

/**
 * Mark the open Junior pull requests on one base branch for a check at
 * `dueAt`. A check that already waits keeps its earlier time, so pushes
 * that keep coming do not delay it. Return the number of marked pull
 * requests.
 */
export async function markGitHubConflictChecks(
  db: GitHubDb,
  input: { baseBranch: string; dueAt: Date; repositoryFullName: string },
): Promise<number> {
  const t = juniorGitHubPullRequests;
  const marked = await db
    .update(t)
    .set({
      // `least` ignores null, so this also sets a check that does not wait.
      // It also moves a running check's claim earlier, so the running check
      // does not end this new one.
      conflictCheckAt: sql`least(${t.conflictCheckAt}, ${input.dueAt.toISOString()}::timestamptz)`,
      conflictCheckAttempts: 0,
    })
    .where(
      and(
        eq(t.repositoryFullName, input.repositoryFullName),
        eq(t.baseBranch, input.baseBranch),
        eq(t.state, "open"),
      ),
    )
    .returning({ pullRequestId: t.pullRequestId });
  return marked.length;
}

/**
 * Claim up to `limit` checks that are due. A claim moves the check to
 * `claimedUntil`, so a check that stops without an end runs again then.
 */
export async function claimGitHubConflictChecks(
  db: GitHubDb,
  input: { claimedUntil: Date; limit: number; now: Date },
): Promise<GitHubConflictCheck[]> {
  const t = juniorGitHubPullRequests;
  const due = db
    .select({ pullRequestId: t.pullRequestId })
    .from(t)
    .where(
      and(
        eq(t.state, "open"),
        isNotNull(t.conflictCheckAt),
        lte(t.conflictCheckAt, input.now),
      ),
    )
    .orderBy(t.conflictCheckAt)
    .limit(input.limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(t)
    .set({
      conflictCheckAt: input.claimedUntil,
      conflictCheckAttempts: sql`${t.conflictCheckAttempts} + 1`,
    })
    .where(inArray(t.pullRequestId, due))
    .returning({
      attempts: t.conflictCheckAttempts,
      number: t.number,
      pullRequestId: t.pullRequestId,
      repositoryFullName: t.repositoryFullName,
    });
  return rows.map((row) => ({ ...row, claimedUntil: input.claimedUntil }));
}

/**
 * End a claimed check, or move it to `retryAt`. Does nothing when a push
 * marked the pull request again during the check.
 */
export async function settleGitHubConflictCheck(
  db: GitHubDb,
  check: GitHubConflictCheck,
  retryAt?: Date,
): Promise<void> {
  const t = juniorGitHubPullRequests;
  await db
    .update(t)
    .set(
      retryAt
        ? { conflictCheckAt: retryAt }
        : { conflictCheckAt: null, conflictCheckAttempts: 0 },
    )
    .where(
      and(
        eq(t.pullRequestId, check.pullRequestId),
        eq(t.conflictCheckAt, check.claimedUntil),
      ),
    );
}
