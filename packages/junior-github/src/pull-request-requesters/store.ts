import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequestRequesters } from "../db/schema.js";

/** One person who asked Junior to open or update a pull request. */
export interface GitHubPullRequestRequester {
  /** Linked GitHub login, when the person linked a GitHub account. */
  githubLogin?: string;
  /** Junior identity that acted. */
  identityId: string;
  /** Junior user linked to that identity, when known. */
  userId?: string;
}

/** Where a requester row points before or after GitHub opens the PR. */
interface PendingTarget {
  headBranch: string;
  repositoryFullName: string;
}

const table = juniorGitHubPullRequestRequesters;

function pendingRows(target: PendingTarget) {
  return and(
    eq(table.repositoryFullName, target.repositoryFullName.toLowerCase()),
    eq(table.headBranch, target.headBranch),
    isNull(table.number),
  );
}

function requesterValues(requester: GitHubPullRequestRequester) {
  return {
    githubLogin: requester.githubLogin ?? null,
    identityId: requester.identityId,
    userId: requester.userId ?? null,
  };
}

/**
 * Save the person who asks Junior to open a pull request, before GitHub opens
 * it, so the `opened` webhook can read it. It replaces any pending row for the
 * branch. Rows of pull requests that GitHub already opened do not change.
 * Pass no requester to only remove the pending row.
 */
export async function recordPendingGitHubPullRequestRequester(
  db: GitHubDb,
  input: PendingTarget & { requester?: GitHubPullRequestRequester },
): Promise<void> {
  await db.delete(table).where(pendingRows(input));
  if (!input.requester) return;
  const now = new Date();
  await db.insert(table).values({
    ...requesterValues(input.requester),
    action: "create",
    createdAt: now,
    headBranch: input.headBranch,
    repositoryFullName: input.repositoryFullName.toLowerCase(),
    updatedAt: now,
  });
}

/**
 * Link the pending requester row to the pull request GitHub opened. GitHub
 * just gave out this number, so any older row for it belongs to an earlier
 * repository with the same name, and is removed.
 */
export async function attachGitHubPullRequestRequester(
  db: GitHubDb,
  input: PendingTarget & { number: number },
): Promise<void> {
  await db
    .delete(table)
    .where(
      and(
        eq(table.repositoryFullName, input.repositoryFullName.toLowerCase()),
        eq(table.number, input.number),
      ),
    );
  await db
    .update(table)
    .set({ number: input.number, updatedAt: new Date() })
    .where(pendingRows(input));
}

/**
 * Add a person who asked Junior to update a pull request. A person who is
 * already a requester keeps their row and action, so the opener does not
 * change.
 */
export async function recordGitHubPullRequestRequester(
  db: GitHubDb,
  input: {
    number: number;
    repositoryFullName: string;
    requester: GitHubPullRequestRequester;
  },
): Promise<void> {
  const now = new Date();
  const values = requesterValues(input.requester);
  await db
    .insert(table)
    .values({
      ...values,
      action: "update",
      createdAt: now,
      number: input.number,
      repositoryFullName: input.repositoryFullName.toLowerCase(),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [table.repositoryFullName, table.number, table.identityId],
      targetWhere: sql`${table.number} IS NOT NULL`,
      set: {
        githubLogin: values.githubLogin,
        updatedAt: now,
        userId: values.userId,
      },
    });
}

/**
 * Load the person who asked Junior to open each pull request: its `create`
 * row. Pass `pendingHeadBranch` only for the `opened` webhook, which can
 * arrive before the create tool links the row to the number. A pending row is
 * used only when the pull request has no linked `create` row, so a create
 * call that GitHub later rejects cannot change an open pull request.
 */
export async function listGitHubPullRequestOpeners(
  db: GitHubDb,
  input: {
    pullRequests: Array<{ number: number; pendingHeadBranch?: string }>;
    repositoryFullName: string;
  },
): Promise<Map<number, GitHubPullRequestRequester>> {
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
        eq(table.action, "create"),
        or(
          inArray(table.number, numbers),
          headBranches.length > 0
            ? and(isNull(table.number), inArray(table.headBranch, headBranches))
            : undefined,
        ),
      ),
    )
    .orderBy(asc(table.createdAt));
  const openers = new Map<number, GitHubPullRequestRequester>();
  for (const pr of input.pullRequests) {
    const row =
      rows.find((candidate) => candidate.number === pr.number) ??
      (pr.pendingHeadBranch
        ? rows.find(
            (candidate) =>
              candidate.number === null &&
              candidate.headBranch === pr.pendingHeadBranch,
          )
        : undefined);
    if (!row) continue;
    openers.set(pr.number, {
      identityId: row.identityId,
      ...(row.githubLogin ? { githubLogin: row.githubLogin } : undefined),
      ...(row.userId ? { userId: row.userId } : undefined),
    });
  }
  return openers;
}
