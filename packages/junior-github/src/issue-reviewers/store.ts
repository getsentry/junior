import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubIssueReviewers } from "../db/schema.js";

const table = juniorGitHubIssueReviewers;

/** One person whose review a Junior issue waits on. */
interface GitHubIssueReviewer {
  conversationId: string;
  /** Lowercase GitHub login. */
  login: string;
  number: number;
  /** Lowercase `owner/name`. */
  repositoryFullName: string;
}

/** An issue, as the reviewer rows name it. */
export interface GitHubIssueRef {
  number: number;
  repositoryFullName: string;
}

function issueWhere(issue: GitHubIssueRef) {
  return and(
    eq(table.repositoryFullName, issue.repositoryFullName.toLowerCase()),
    eq(table.number, issue.number),
  );
}

/**
 * Save the people whose review an issue waits on. A retry of the same create
 * call keeps the first rows.
 */
export async function recordGitHubIssueReviewers(
  db: GitHubDb,
  input: GitHubIssueRef & { conversationId: string; logins: string[] },
): Promise<void> {
  if (input.logins.length === 0) return;
  const now = new Date();
  await db
    .insert(table)
    .values(
      input.logins.map((login) => ({
        conversationId: input.conversationId,
        createdAt: now,
        login: login.toLowerCase(),
        number: input.number,
        repositoryFullName: input.repositoryFullName.toLowerCase(),
      })),
    )
    .onConflictDoNothing();
}

/** Load the reviewers of one issue. */
export async function listGitHubIssueReviewers(
  db: GitHubDb,
  issue: GitHubIssueRef,
): Promise<GitHubIssueReviewer[]> {
  return await db
    .select({
      conversationId: table.conversationId,
      login: table.login,
      number: table.number,
      repositoryFullName: table.repositoryFullName,
    })
    .from(table)
    .where(issueWhere(issue));
}

/** Remove the rows of reviewers whose item closed. */
export async function deleteGitHubIssueReviewers(
  db: GitHubDb,
  issue: GitHubIssueRef,
  logins: string[],
): Promise<void> {
  if (logins.length === 0) return;
  await db
    .delete(table)
    .where(and(issueWhere(issue), inArray(table.login, logins)));
}

/**
 * Claim the reviewers whose reactions are due for a read: added after
 * `since`, and not read after `checkedBefore`, the oldest read first. The
 * claim locks the rows and marks them read at `now`, so a concurrent
 * heartbeat skips them.
 */
export async function claimGitHubIssueReviewersForReactions(
  db: GitHubDb,
  input: { checkedBefore: Date; limit: number; now: Date; since: Date },
): Promise<GitHubIssueReviewer[]> {
  // The columns are in the order of the key that the update matches.
  const due = db
    .select({
      repositoryFullName: table.repositoryFullName,
      number: table.number,
      login: table.login,
    })
    .from(table)
    .where(
      and(
        gt(table.createdAt, input.since),
        or(isNull(table.checkedAt), lt(table.checkedAt, input.checkedBefore)),
      ),
    )
    .orderBy(sql`${table.checkedAt} asc nulls first`, asc(table.createdAt))
    .limit(input.limit)
    // A concurrent heartbeat skips the rows that this claim locked, so it
    // cannot claim them again after this update commits.
    .for("update", { skipLocked: true });
  return await db
    .update(table)
    .set({ checkedAt: input.now })
    .where(
      sql`(${table.repositoryFullName}, ${table.number}, ${table.login}) in (${due})`,
    )
    .returning({
      conversationId: table.conversationId,
      login: table.login,
      number: table.number,
      repositoryFullName: table.repositoryFullName,
    });
}
