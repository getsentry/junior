import { and, eq, lte, sql } from "drizzle-orm";
import * as z from "zod";
import {
  type CodeChange,
  codeChangeSizeSchema,
  type PluginCodeChanges,
} from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../db/database.js";
import {
  type GitHubPullRequestAction,
  type GitHubPullRequestCommitComposition,
  githubPullRequestCommitCompositionSchema,
  githubPullRequestStateSchema,
  juniorGitHubPullRequests,
} from "../db/schema.js";

/** One pull request lifecycle outcome, as the webhook and reconcile read it. */
export const githubPullRequestOutcomeInputSchema = z
  .object({
    candidateOwned: z.boolean(),
    closedAt: z.date().optional(),
    commitComposition: githubPullRequestCommitCompositionSchema.optional(),
    /**
     * Written to Junior's code index only. When omitted, the stored draft
     * state does not change.
     */
    draft: z.boolean().optional(),
    mergedAt: z.date().optional(),
    number: z.number().int().positive(),
    openedAt: z.date(),
    pullRequestId: z.string().min(1),
    repositoryFullName: z.string().min(1),
    repositoryId: z.string().min(1),
    /** Written to Junior's code index only, not to the GitHub row. */
    size: codeChangeSizeSchema.optional(),
    state: githubPullRequestStateSchema,
    title: z.string().min(1).optional(),
    updatedAt: z.date(),
  })
  .strict();

export type GitHubPullRequestOutcomeInput = z.output<
  typeof githubPullRequestOutcomeInputSchema
>;

/** Conversations that a pull request body links to its pull request. */
export interface GitHubPullRequestConversationsInput {
  conversationIds: string[];
  pullRequestId: string;
}

/**
 * Record one Junior-owned pull request. The lifecycle goes to Junior's code
 * index, and this row keeps what Junior records for the pull request. An
 * ownership-qualified opening or terminal recovery inserts; later events
 * update existing rows, and older provider timestamps cannot regress it.
 * Returns whether the row changed, so follow-up enrichment can remain
 * idempotent.
 */
export async function recordGitHubPullRequestOutcome(
  db: GitHubDb,
  input: GitHubPullRequestOutcomeInput,
): Promise<{
  applied: boolean;
  commitComposition: GitHubPullRequestCommitComposition | undefined;
}> {
  const outcome = githubPullRequestOutcomeInputSchema.parse(input);
  const t = juniorGitHubPullRequests;
  const values = {
    ...(outcome.commitComposition
      ? { commitComposition: outcome.commitComposition }
      : undefined),
    updatedAt: outcome.updatedAt,
  };
  const written = outcome.candidateOwned
    ? await db
        .insert(t)
        .values({ pullRequestId: outcome.pullRequestId, ...values })
        .onConflictDoUpdate({
          target: t.pullRequestId,
          set: values,
          where: lte(t.updatedAt, outcome.updatedAt),
        })
        .returning({ commitComposition: t.commitComposition })
    : await db
        .update(t)
        .set(values)
        .where(
          and(
            eq(t.pullRequestId, outcome.pullRequestId),
            lte(t.updatedAt, outcome.updatedAt),
          ),
        )
        .returning({ commitComposition: t.commitComposition });
  return {
    applied: written.length > 0,
    commitComposition: written[0]?.commitComposition ?? undefined,
  };
}

/**
 * Read one Junior pull request from Junior's code index, by repository name,
 * in any case, and number.
 */
export async function findGitHubPullRequest(
  codeChanges: Pick<PluginCodeChanges, "list">,
  ref: { number: number; repositoryFullName: string },
): Promise<CodeChange | undefined> {
  const [change] = await codeChanges.list({
    repository: { name: ref.repositoryFullName, numbers: [ref.number] },
  });
  return change;
}

/**
 * Ask to check the next action of a Junior pull request, and claim the check
 * when no other webhook runs one. A claim older than `staleMs` is free.
 * Return the claim and the saved action, or undefined when another webhook
 * runs the check or Junior does not own the pull request. The webhook that
 * runs the check sees the new request in `releaseGitHubPullRequestReadySync`.
 */
export async function claimGitHubPullRequestReadySync(
  db: GitHubDb,
  pullRequestId: string,
  options: { now: Date; staleMs: number },
): Promise<
  | {
      action: GitHubPullRequestAction | undefined;
      id: number;
      requests: number;
    }
  | undefined
> {
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
    .where(eq(t.pullRequestId, pullRequestId))
    .returning({
      action: t.nextAction,
      id: t.readySyncId,
      requests: t.readySyncRequests,
    });
  if (!row || row.id !== row.requests) return undefined;
  return {
    action: row.action ?? undefined,
    id: row.id,
    requests: row.requests,
  };
}

/** Save the next action of a Junior pull request. */
export async function setGitHubPullRequestNextAction(
  db: GitHubDb,
  pullRequestId: string,
  action: GitHubPullRequestAction | undefined,
): Promise<void> {
  await db
    .update(juniorGitHubPullRequests)
    .set({ nextAction: action ?? null })
    .where(eq(juniorGitHubPullRequests.pullRequestId, pullRequestId));
}

/**
 * End a claimed check. When a webhook asked again during the check, keep the
 * claim and return the new request count, so the caller checks once more.
 * Return undefined when the claim ended or another webhook took it.
 */
export async function releaseGitHubPullRequestReadySync(
  db: GitHubDb,
  pullRequestId: string,
  claim: { id: number; requests: number },
): Promise<number | undefined> {
  const t = juniorGitHubPullRequests;
  const claimed = and(
    eq(t.pullRequestId, pullRequestId),
    eq(t.readySyncId, claim.id),
  );
  const released = await db
    .update(t)
    .set({ readySyncAt: null, readySyncId: null })
    .where(and(claimed, eq(t.readySyncRequests, claim.requests)))
    .returning({ pullRequestId: t.pullRequestId });
  if (released.length > 0) return undefined;
  const [row] = await db
    .select({ requests: t.readySyncRequests })
    .from(t)
    .where(claimed);
  return row?.requests;
}
