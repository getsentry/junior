import { and, eq, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  type GitHubPullRequestCommitComposition,
  githubPullRequestCommitCompositionSchema,
  githubPullRequestStateSchema,
  juniorGitHubPullRequestIssues,
  juniorGitHubPullRequests,
} from "../db/schema.js";

const githubPullRequestOutcomeInputSchema = z
  .object({
    candidateOwned: z.boolean(),
    closedAt: z.date().optional(),
    commitComposition: githubPullRequestCommitCompositionSchema.optional(),
    mergedAt: z.date().optional(),
    number: z.number().int().positive(),
    openedAt: z.date(),
    pullRequestId: z.string().min(1),
    repositoryFullName: z.string().min(1),
    repositoryId: z.string().min(1),
    state: githubPullRequestStateSchema,
    title: z.string().min(1).optional(),
    updatedAt: z.date(),
  })
  .strict();

export type GitHubPullRequestOutcomeInput = z.output<
  typeof githubPullRequestOutcomeInputSchema
>;

const githubPullRequestConversationsInputSchema = z
  .object({
    conversationIds: z.array(z.string().min(1)).min(1),
    pullRequestId: z.string().min(1),
  })
  .strict();

export type GitHubPullRequestConversationsInput = z.output<
  typeof githubPullRequestConversationsInputSchema
>;

const githubPullRequestLinkedIssuesInputSchema = z
  .object({
    linkedIssues: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            repositoryFullName: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    pullRequestId: z.string().min(1),
  })
  .strict();

export type GitHubPullRequestLinkedIssuesInput = z.output<
  typeof githubPullRequestLinkedIssuesInputSchema
>;

/** Select mutable lifecycle fields while excluding transient ownership inputs. */
function projectionValues(input: GitHubPullRequestOutcomeInput) {
  return {
    closedAt: input.closedAt ?? null,
    ...(input.commitComposition
      ? { commitComposition: input.commitComposition }
      : undefined),
    mergedAt: input.mergedAt ?? null,
    number: input.number,
    openedAt: input.openedAt,
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
    state: input.state,
    updatedAt: input.updatedAt,
  };
}

/**
 * Record the newest lifecycle projection for one Junior-owned pull request.
 * An ownership-qualified opening or terminal recovery inserts; later events
 * update existing rows, and older provider timestamps cannot regress it.
 * Returns the written row state so follow-up enrichment can remain idempotent.
 */
export async function recordGitHubPullRequestOutcome(
  db: GitHubDb,
  input: GitHubPullRequestOutcomeInput,
): Promise<{
  applied: boolean;
  commitComposition: GitHubPullRequestCommitComposition | undefined;
  conversationIds: string[];
}> {
  const outcome = githubPullRequestOutcomeInputSchema.parse(input);
  const values = projectionValues(outcome);
  if (!outcome.candidateOwned) {
    const updated = await db
      .update(juniorGitHubPullRequests)
      .set(values)
      .where(
        and(
          eq(juniorGitHubPullRequests.pullRequestId, outcome.pullRequestId),
          lte(juniorGitHubPullRequests.updatedAt, outcome.updatedAt),
        ),
      )
      .returning({
        commitComposition: juniorGitHubPullRequests.commitComposition,
        conversationIds: juniorGitHubPullRequests.conversationIds,
      });
    return {
      applied: updated.length > 0,
      commitComposition: updated[0]?.commitComposition ?? undefined,
      conversationIds: updated[0]?.conversationIds ?? [],
    };
  }

  const inserted = await db
    .insert(juniorGitHubPullRequests)
    .values({ pullRequestId: outcome.pullRequestId, ...values })
    .onConflictDoUpdate({
      target: juniorGitHubPullRequests.pullRequestId,
      set: values,
      where: lte(juniorGitHubPullRequests.updatedAt, outcome.updatedAt),
    })
    .returning({
      commitComposition: juniorGitHubPullRequests.commitComposition,
      conversationIds: juniorGitHubPullRequests.conversationIds,
    });
  return {
    applied: inserted.length > 0,
    commitComposition: inserted[0]?.commitComposition ?? undefined,
    conversationIds: inserted[0]?.conversationIds ?? [],
  };
}

function conversationIdsForPullRequests(
  rows: Array<{ conversationIds: string[] }>,
  conversationIds: string[],
): string[] {
  const candidates = new Set(conversationIds);
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.conversationIds.filter((conversationId) =>
          candidates.has(conversationId),
        ),
      ),
    ),
  ];
}

/** Return candidate conversations that have an associated unmerged pull request. */
export async function listGitHubUnfinishedWork(
  db: GitHubDb,
  conversationIds: string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const values = sql.join(
    conversationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db
    .select({ conversationIds: juniorGitHubPullRequests.conversationIds })
    .from(juniorGitHubPullRequests)
    .where(
      and(
        ne(juniorGitHubPullRequests.state, "merged"),
        sql`${juniorGitHubPullRequests.conversationIds} && ARRAY[${values}]::text[]`,
      ),
    );
  return conversationIdsForPullRequests(rows, conversationIds);
}

/** Return the latest merge time for each candidate conversation. */
export async function listGitHubFinishedWork(
  db: GitHubDb,
  conversationIds: string[],
): Promise<Record<string, string>> {
  if (conversationIds.length === 0) return {};
  const values = sql.join(
    conversationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db
    .select({
      conversationIds: juniorGitHubPullRequests.conversationIds,
      mergedAt: juniorGitHubPullRequests.mergedAt,
    })
    .from(juniorGitHubPullRequests)
    .where(
      and(
        eq(juniorGitHubPullRequests.state, "merged"),
        sql`${juniorGitHubPullRequests.conversationIds} && ARRAY[${values}]::text[]`,
      ),
    );
  const candidates = new Set(conversationIds);
  const finishedAtById = new Map<string, Date>();
  for (const row of rows) {
    if (!row.mergedAt) continue;
    for (const conversationId of row.conversationIds) {
      if (!candidates.has(conversationId)) continue;
      const current = finishedAtById.get(conversationId);
      if (!current || row.mergedAt > current) {
        finishedAtById.set(conversationId, row.mergedAt);
      }
    }
  }
  return Object.fromEntries(
    conversationIds.flatMap((conversationId) => {
      const finishedAt = finishedAtById.get(conversationId);
      return finishedAt ? [[conversationId, finishedAt.toISOString()]] : [];
    }),
  );
}

/** Return candidate conversations linked to any Junior-owned pull request. */
export async function listGitHubAssignedWork(
  db: GitHubDb,
  conversationIds: string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const values = sql.join(
    conversationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db
    .select({ conversationIds: juniorGitHubPullRequests.conversationIds })
    .from(juniorGitHubPullRequests)
    .where(
      sql`${juniorGitHubPullRequests.conversationIds} && ARRAY[${values}]::text[]`,
    );
  return conversationIdsForPullRequests(rows, conversationIds);
}

/** Append native conversation ids to an existing Junior-owned PR projection. */
export async function recordGitHubPullRequestConversations(
  db: GitHubDb,
  input: GitHubPullRequestConversationsInput,
): Promise<boolean> {
  const association = githubPullRequestConversationsInputSchema.parse(input);
  const conversationIds = sql.join(
    association.conversationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const updated = await db
    .update(juniorGitHubPullRequests)
    .set({
      conversationIds: sql`ARRAY(
        SELECT DISTINCT value
        FROM unnest(
          ${juniorGitHubPullRequests.conversationIds}
          || ARRAY[${conversationIds}]::text[]
        ) AS value
        ORDER BY value
      )`,
    })
    .where(
      eq(juniorGitHubPullRequests.pullRequestId, association.pullRequestId),
    )
    .returning({ pullRequestId: juniorGitHubPullRequests.pullRequestId });
  return updated.length > 0;
}

/** Link an existing Junior-owned PR to tracked issues across repositories. */
export async function recordGitHubPullRequestLinkedIssues(
  db: GitHubDb,
  input: GitHubPullRequestLinkedIssuesInput,
): Promise<boolean> {
  const association = githubPullRequestLinkedIssuesInputSchema.parse(input);
  const inserted = await Promise.all(
    association.linkedIssues.map((issue) =>
      db
        .insert(juniorGitHubPullRequestIssues)
        .select(
          db
            .select({
              pullRequestId: juniorGitHubPullRequests.pullRequestId,
              issueRepositoryFullName:
                sql<string>`lower(${issue.repositoryFullName})`.as(
                  "issue_repository_full_name",
                ),
              issueNumber: sql<number>`${issue.number}`.as("issue_number"),
            })
            .from(juniorGitHubPullRequests)
            .where(
              eq(
                juniorGitHubPullRequests.pullRequestId,
                association.pullRequestId,
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({
          issueNumber: juniorGitHubPullRequestIssues.issueNumber,
        }),
    ),
  );
  return inserted.some((rows) => rows.length > 0);
}

function pullRequestRow(target: {
  number: number;
  repositoryFullName: string;
}) {
  return and(
    sql`lower(${juniorGitHubPullRequests.repositoryFullName}) = ${target.repositoryFullName.toLowerCase()}`,
    eq(juniorGitHubPullRequests.number, target.number),
  );
}

/**
 * Ask to check whether a Junior pull request is ready to merge, and claim the
 * check when no other webhook runs one. A claim older than `staleMs` is free.
 * Return the claim, or undefined when another webhook runs the check or
 * Junior does not own the pull request. The webhook that runs the check sees
 * the new request in `releaseGitHubPullRequestReadySync`.
 */
export async function claimGitHubPullRequestReadySync(
  db: GitHubDb,
  target: { number: number; repositoryFullName: string },
  options: { now: Date; staleMs: number },
): Promise<{ id: number; ready: boolean; requests: number } | undefined> {
  const t = juniorGitHubPullRequests;
  const staleBefore = new Date(options.now.getTime() - options.staleMs);
  const free = sql`(${t.readySyncId} is null or ${t.readySyncAt} < ${staleBefore.toISOString()}::timestamptz)`;
  const [row] = await db
    .update(t)
    .set({
      readySyncRequests: sql`${t.readySyncRequests} + 1`,
      // Each request has its own number, so it is the id of the claim.
      readySyncId: sql`case when ${free} then ${t.readySyncRequests} + 1 else ${t.readySyncId} end`,
      readySyncAt: sql`case when ${free} then ${options.now.toISOString()}::timestamptz else ${t.readySyncAt} end`,
    })
    .where(pullRequestRow(target))
    .returning({
      id: t.readySyncId,
      readyToMergeAt: t.readyToMergeAt,
      requests: t.readySyncRequests,
    });
  if (!row || row.id !== row.requests) return undefined;
  return {
    id: row.id,
    ready: row.readyToMergeAt !== null,
    requests: row.requests,
  };
}

/** Save whether a Junior pull request is ready to merge. */
export async function setGitHubPullRequestReadyToMerge(
  db: GitHubDb,
  target: { number: number; ready: boolean; repositoryFullName: string },
): Promise<void> {
  await db
    .update(juniorGitHubPullRequests)
    .set({ readyToMergeAt: target.ready ? new Date() : null })
    .where(pullRequestRow(target));
}

/**
 * End a claimed check. When a webhook asked again during the check, keep the
 * claim and return the new request count, so the caller checks once more.
 * Return undefined when the claim ended or another webhook took it.
 */
export async function releaseGitHubPullRequestReadySync(
  db: GitHubDb,
  target: { number: number; repositoryFullName: string },
  claim: { id: number; requests: number },
): Promise<number | undefined> {
  const t = juniorGitHubPullRequests;
  const claimed = and(pullRequestRow(target), eq(t.readySyncId, claim.id));
  const released = await db
    .update(t)
    .set({ readySyncAt: null, readySyncId: null })
    .where(and(claimed, eq(t.readySyncRequests, claim.requests)))
    .returning({ number: t.number });
  if (released.length > 0) return undefined;
  const [row] = await db
    .select({ requests: t.readySyncRequests })
    .from(t)
    .where(claimed);
  return row?.requests;
}
