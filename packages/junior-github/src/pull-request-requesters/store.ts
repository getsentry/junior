import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequestRequesters } from "../db/schema.js";

const table = juniorGitHubPullRequestRequesters;

/**
 * Save the person who asked Junior to open a pull request, after GitHub
 * opens it.
 *
 * `createdAt` is when the create call started. The row uses it, so the opener
 * stays the first row for the number. Any row for the number from before that
 * time belongs to an earlier repository with the same name, and is removed. A
 * retry of the same create call can call this again.
 */
export async function recordGitHubPullRequestOpener(
  db: GitHubDb,
  input: {
    conversationId: string;
    createdAt: Date;
    identityId: string;
    number: number;
    /** GitHub's id of the pull request, when the create result has it. */
    pullRequestId?: string | undefined;
    repositoryFullName: string;
  },
): Promise<void> {
  const repositoryFullName = input.repositoryFullName.toLowerCase();
  const pullRequestId = input.pullRequestId ?? null;
  await db
    .insert(table)
    .values({
      conversationId: input.conversationId,
      createdAt: input.createdAt,
      identityId: input.identityId,
      number: input.number,
      pullRequestId,
      repositoryFullName,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [table.repositoryFullName, table.number, table.identityId],
      set: {
        conversationId: input.conversationId,
        createdAt: input.createdAt,
        ...(pullRequestId ? { pullRequestId } : undefined),
      },
    });
  await db
    .delete(table)
    .where(
      and(
        eq(table.repositoryFullName, repositoryFullName),
        eq(table.number, input.number),
        lt(table.createdAt, input.createdAt),
      ),
    );
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
      set: { updatedAt: now },
    });
}

/** The first person who asked Junior for a pull request. */
export interface GitHubPullRequestOpener {
  /** Set only for the person who asked Junior to open it. */
  conversationId?: string;
  identityId: string;
}

/**
 * Load the first requester of each pull request. This is the person who
 * asked Junior to open it, or, when the create had no identity, the first
 * person who asked Junior to update it.
 */
export async function listGitHubPullRequestOpeners(
  db: GitHubDb,
  input: { numbers: number[]; repositoryFullName: string },
): Promise<Map<number, GitHubPullRequestOpener>> {
  const openers = new Map<number, GitHubPullRequestOpener>();
  if (input.numbers.length === 0) return openers;
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.repositoryFullName, input.repositoryFullName.toLowerCase()),
        inArray(table.number, [...new Set(input.numbers)]),
      ),
    )
    .orderBy(asc(table.createdAt));
  for (const row of rows) {
    if (!openers.has(row.number)) {
      openers.set(row.number, {
        identityId: row.identityId,
        ...(row.conversationId
          ? { conversationId: row.conversationId }
          : undefined),
      });
    }
  }
  return openers;
}

/**
 * Find a pull request that a person asked Junior to open in one
 * Conversation, by GitHub's id of the pull request.
 */
export async function findGitHubPullRequestOpenedIn(
  db: GitHubDb,
  input: { conversationId: string; pullRequestId: string },
): Promise<{ number: number; repositoryFullName: string } | undefined> {
  const [row] = await db
    .select({
      number: table.number,
      repositoryFullName: table.repositoryFullName,
    })
    .from(table)
    .where(
      and(
        eq(table.conversationId, input.conversationId),
        eq(table.pullRequestId, input.pullRequestId),
      ),
    )
    .limit(1);
  return row;
}
