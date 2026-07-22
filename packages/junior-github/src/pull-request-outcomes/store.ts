import { and, eq, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { z } from "zod";
import {
  githubSqlSchema,
  githubPullRequestStateSchema,
  juniorGitHubPullRequests,
} from "../db/schema.js";

export type GitHubDb = PgDatabase<PgQueryResultHKT, typeof githubSqlSchema>;

const githubPullRequestOutcomeInputSchema = z
  .object({
    candidateOwned: z.boolean(),
    closedAt: z.date().optional(),
    mergedAt: z.date().optional(),
    number: z.number().int().positive(),
    openedAt: z.date(),
    pullRequestId: z.string().min(1),
    repositoryFullName: z.string().min(1),
    repositoryId: z.string().min(1),
    state: githubPullRequestStateSchema,
    updatedAt: z.date(),
  })
  .strict();

const githubPullRequestRowSchema = z
  .object({
    closedAt: z.date().nullable(),
    mergedAt: z.date().nullable(),
    number: z.number().int().positive(),
    openedAt: z.date(),
    pullRequestId: z.string().min(1),
    repositoryFullName: z.string().min(1),
    repositoryId: z.string().min(1),
    state: githubPullRequestStateSchema,
    updatedAt: z.date(),
  })
  .strict();

export type GitHubPullRequestOutcomeInput = z.output<
  typeof githubPullRequestOutcomeInputSchema
>;
export type GitHubPullRequestRow = z.output<typeof githubPullRequestRowSchema>;

/** Select mutable lifecycle fields while excluding transient ownership inputs. */
function projectionValues(input: GitHubPullRequestOutcomeInput) {
  return {
    closedAt: input.closedAt ?? null,
    mergedAt: input.mergedAt ?? null,
    number: input.number,
    openedAt: input.openedAt,
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
    state: input.state,
    updatedAt: input.updatedAt,
  };
}

/** Assert rows loaded from the durable pull request projection. */
export function parseGitHubPullRequestRows(
  input: unknown,
): GitHubPullRequestRow[] {
  return z.array(githubPullRequestRowSchema).parse(input);
}

/**
 * Record the newest lifecycle projection for one Junior-owned pull request.
 * Only an ownership-qualified opening inserts; later events update existing
 * rows, and older provider timestamps cannot regress the projection.
 */
export async function recordGitHubPullRequestOutcome(
  db: GitHubDb,
  input: GitHubPullRequestOutcomeInput,
): Promise<void> {
  const outcome = githubPullRequestOutcomeInputSchema.parse(input);
  const values = projectionValues(outcome);
  if (!outcome.candidateOwned) {
    await db
      .update(juniorGitHubPullRequests)
      .set(values)
      .where(
        and(
          eq(juniorGitHubPullRequests.pullRequestId, outcome.pullRequestId),
          lte(juniorGitHubPullRequests.updatedAt, outcome.updatedAt),
        ),
      );
    return;
  }

  await db
    .insert(juniorGitHubPullRequests)
    .values({ pullRequestId: outcome.pullRequestId, ...values })
    .onConflictDoUpdate({
      target: juniorGitHubPullRequests.pullRequestId,
      set: values,
      where: lte(juniorGitHubPullRequests.updatedAt, outcome.updatedAt),
    });
}
