/**
 * Merge conflict checks that wait for the heartbeat, one per repository.
 *
 * A push to the default branch adds a check, or moves a waiting check
 * earlier. The push webhook only writes rows. The heartbeat reads GitHub
 * later, so a burst of pushes gives one check, and GitHub has time to
 * calculate mergeability.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import {
  juniorGitHubConflictChecks,
  juniorGitHubPullRequests,
} from "../db/schema.js";

/** One claimed check. `claimedUntil` identifies the claim. */
export interface GitHubConflictCheck {
  attempts: number;
  claimedUntil: Date;
  repositoryFullName: string;
}

/** Return the numbers of the open Junior pull requests in one repository. */
export async function listOpenGitHubPullRequestNumbers(
  db: GitHubDb,
  repositoryFullName: string,
): Promise<number[]> {
  const t = juniorGitHubPullRequests;
  const rows = await db
    .select({ number: t.number })
    .from(t)
    .where(
      and(eq(t.repositoryFullName, repositoryFullName), eq(t.state, "open")),
    )
    .orderBy(t.number);
  return rows.map((row) => row.number);
}

/**
 * Add a check at `dueAt` for a repository with open Junior pull requests. A
 * check that already waits keeps its earlier time, so pushes that keep
 * coming do not delay it. Return whether a check waits.
 */
export async function scheduleGitHubConflictCheck(
  db: GitHubDb,
  input: { dueAt: Date; repositoryFullName: string },
): Promise<boolean> {
  const t = juniorGitHubPullRequests;
  const [open] = await db
    .select({ number: t.number })
    .from(t)
    .where(
      and(
        eq(t.repositoryFullName, input.repositoryFullName),
        eq(t.state, "open"),
      ),
    )
    .limit(1);
  if (!open) return false;
  const c = juniorGitHubConflictChecks;
  await db
    .insert(c)
    .values({
      dueAt: input.dueAt,
      repositoryFullName: input.repositoryFullName,
    })
    .onConflictDoUpdate({
      target: c.repositoryFullName,
      set: {
        attempts: 0,
        // This also moves a running check's claim earlier, so the running
        // check does not remove this new one.
        dueAt: sql`least(${c.dueAt}, excluded.due_at)`,
      },
    });
  return true;
}

/**
 * Claim up to `limit` checks that are due. A claim moves the check to
 * `claimedUntil`, so a check that stops without an end runs again then.
 */
export async function claimGitHubConflictChecks(
  db: GitHubDb,
  input: { claimedUntil: Date; limit: number; now: Date },
): Promise<GitHubConflictCheck[]> {
  const c = juniorGitHubConflictChecks;
  const due = db
    .select({ repositoryFullName: c.repositoryFullName })
    .from(c)
    .where(lte(c.dueAt, input.now))
    .orderBy(c.dueAt)
    .limit(input.limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(c)
    .set({ attempts: sql`${c.attempts} + 1`, dueAt: input.claimedUntil })
    .where(inArray(c.repositoryFullName, due))
    .returning({
      attempts: c.attempts,
      repositoryFullName: c.repositoryFullName,
    });
  return rows.map((row) => ({ ...row, claimedUntil: input.claimedUntil }));
}

/**
 * Remove a claimed check, or move it to `retryAt`. Does nothing when a push
 * moved the check during the claim.
 */
export async function settleGitHubConflictCheck(
  db: GitHubDb,
  check: GitHubConflictCheck,
  retryAt?: Date,
): Promise<void> {
  const c = juniorGitHubConflictChecks;
  const claimed = and(
    eq(c.repositoryFullName, check.repositoryFullName),
    eq(c.dueAt, check.claimedUntil),
  );
  if (retryAt) {
    await db.update(c).set({ dueAt: retryAt }).where(claimed);
    return;
  }
  await db.delete(c).where(claimed);
}
