import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequestRequesters } from "../db/schema.js";

/** The head branch that a create call names, before GitHub gives a number. */
interface PendingTarget {
  headBranch: string;
  repositoryFullName: string;
}

const table = juniorGitHubPullRequestRequesters;

/**
 * A pending row older than this belongs to a create call that stopped before
 * it could link or remove the row. Webhooks ignore it.
 */
const PENDING_REQUESTER_MAX_AGE_MS = 10 * 60 * 1000;

function pendingRow(target: PendingTarget, identityId: string) {
  return and(
    eq(table.repositoryFullName, target.repositoryFullName.toLowerCase()),
    eq(table.headBranch, target.headBranch),
    eq(table.identityId, identityId),
    isNull(table.number),
  );
}

/**
 * Save the person who asks Junior to open a pull request, before GitHub opens
 * it, so the `opened` webhook can read it. It changes only this person's
 * pending row for the branch.
 */
export async function recordPendingGitHubPullRequestRequester(
  db: GitHubDb,
  input: PendingTarget & { identityId: string },
): Promise<void> {
  await removePendingGitHubPullRequestRequester(db, input);
  const now = new Date();
  await db.insert(table).values({
    createdAt: now,
    headBranch: input.headBranch,
    identityId: input.identityId,
    repositoryFullName: input.repositoryFullName.toLowerCase(),
    updatedAt: now,
  });
}

/** Remove this person's pending row after GitHub rejects their create. */
export async function removePendingGitHubPullRequestRequester(
  db: GitHubDb,
  input: PendingTarget & { identityId: string },
): Promise<void> {
  await db.delete(table).where(pendingRow(input, input.identityId));
}

/**
 * Save the person who asked Junior to open the pull request GitHub just
 * opened, and remove their pending row. With no identity, it saves no row.
 *
 * `createdAt` is when the create call started. The saved row uses it, so the
 * opener stays the first row for the number. Any row for the number from
 * before that time belongs to an earlier repository with the same name, and
 * is removed. The row is saved before the pending row is removed, so a failure
 * never loses both. A retry of the same create call can call this again.
 */
export async function attachGitHubPullRequestRequester(
  db: GitHubDb,
  input: {
    createdAt: Date;
    headBranch?: string;
    identityId?: string;
    number: number;
    repositoryFullName: string;
  },
): Promise<void> {
  const repositoryFullName = input.repositoryFullName.toLowerCase();
  if (input.identityId) {
    await db
      .insert(table)
      .values({
        createdAt: input.createdAt,
        identityId: input.identityId,
        number: input.number,
        repositoryFullName,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [table.repositoryFullName, table.number, table.identityId],
        targetWhere: sql`${table.number} IS NOT NULL`,
        set: { createdAt: input.createdAt },
      });
  }
  await db
    .delete(table)
    .where(
      and(
        eq(table.repositoryFullName, repositoryFullName),
        eq(table.number, input.number),
        lt(table.createdAt, input.createdAt),
      ),
    );
  if (input.identityId && input.headBranch) {
    await removePendingGitHubPullRequestRequester(db, {
      headBranch: input.headBranch,
      identityId: input.identityId,
      repositoryFullName,
    });
  }
}

/**
 * Add a person who asked Junior to update a pull request. A person who is
 * already a requester keeps their row, so the opener does not change.
 */
export async function recordGitHubPullRequestRequester(
  db: GitHubDb,
  input: {
    identityId: string;
    number: number;
    repositoryFullName: string;
  },
): Promise<void> {
  const now = new Date();
  await db
    .insert(table)
    .values({
      createdAt: now,
      identityId: input.identityId,
      number: input.number,
      repositoryFullName: input.repositoryFullName.toLowerCase(),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [table.repositoryFullName, table.number, table.identityId],
      targetWhere: sql`${table.number} IS NOT NULL`,
      set: { updatedAt: now },
    });
}

/**
 * Load the Junior identity id of the first requester of each pull request.
 * This is the person who asked Junior to open it, or, when the create had no
 * identity, the first person who asked Junior to update it. Pass
 * `pendingHeadBranch` only for the `opened` webhook of a same-repo pull
 * request, which can arrive before the create tool saves its row. A pending
 * row is used only when the pull request has no row and the branch has exactly
 * one recent pending row. Concurrent create calls on one branch are
 * ambiguous, so they give no opener.
 */
export async function listGitHubPullRequestOpeners(
  db: GitHubDb,
  input: {
    pullRequests: Array<{ number: number; pendingHeadBranch?: string }>;
    repositoryFullName: string;
  },
): Promise<Map<number, string>> {
  if (input.pullRequests.length === 0) return new Map();
  const numbers = [...new Set(input.pullRequests.map((pr) => pr.number))];
  const headBranches = [
    ...new Set(
      input.pullRequests.flatMap((pr) =>
        pr.pendingHeadBranch ? [pr.pendingHeadBranch] : [],
      ),
    ),
  ];
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.repositoryFullName, input.repositoryFullName.toLowerCase()),
        or(
          inArray(table.number, numbers),
          headBranches.length > 0
            ? and(
                isNull(table.number),
                inArray(table.headBranch, headBranches),
                gt(
                  table.createdAt,
                  new Date(Date.now() - PENDING_REQUESTER_MAX_AGE_MS),
                ),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(asc(table.createdAt));
  const openers = new Map<number, string>();
  for (const pr of input.pullRequests) {
    const pending = pr.pendingHeadBranch
      ? rows.filter(
          (candidate) =>
            candidate.number === null &&
            candidate.headBranch === pr.pendingHeadBranch,
        )
      : [];
    const row =
      rows.find((candidate) => candidate.number === pr.number) ??
      (pending.length === 1 ? pending[0] : undefined);
    if (row) openers.set(pr.number, row.identityId);
  }
  return openers;
}
