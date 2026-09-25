import { and, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  githubIssueStateReasonSchema,
  githubIssueStateSchema,
  juniorGitHubIssues,
} from "../db/schema.js";

const githubIssueOutcomeInputSchema = z
  .object({
    candidateOwned: z.boolean(),
    closedAt: z.date().optional(),
    issueId: z.string().min(1),
    number: z.number().int().positive(),
    openedAt: z.date(),
    repositoryFullName: z.string().min(1),
    repositoryId: z.string().min(1),
    state: githubIssueStateSchema,
    stateReason: githubIssueStateReasonSchema.optional(),
    updatedAt: z.date(),
  })
  .strict();

export type GitHubIssueOutcomeInput = z.output<
  typeof githubIssueOutcomeInputSchema
>;

const githubIssueConversationsInputSchema = z
  .object({
    conversationIds: z.array(z.string().min(1)).min(1),
    issueId: z.string().min(1),
  })
  .strict();

export type GitHubIssueConversationsInput = z.output<
  typeof githubIssueConversationsInputSchema
>;

/** Select mutable issue lifecycle fields while excluding ownership evidence. */
function projectionValues(input: GitHubIssueOutcomeInput) {
  return {
    closedAt: input.closedAt ?? null,
    number: input.number,
    openedAt: input.openedAt,
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
    state: input.state,
    stateReason: input.stateReason ?? null,
    updatedAt: input.updatedAt,
  };
}

/**
 * Record the newest lifecycle projection for one Junior-owned issue.
 * Ownership-qualified opening or closing events insert; later events update
 * existing rows, and older provider timestamps cannot regress them.
 * Returns the written row state so follow-up annotation updates stay scoped to
 * associated conversations.
 */
export async function recordGitHubIssueOutcome(
  db: GitHubDb,
  input: GitHubIssueOutcomeInput,
): Promise<{ applied: boolean; conversationIds: string[] }> {
  const outcome = githubIssueOutcomeInputSchema.parse(input);
  const values = projectionValues(outcome);
  if (!outcome.candidateOwned) {
    const updated = await db
      .update(juniorGitHubIssues)
      .set(values)
      .where(
        and(
          eq(juniorGitHubIssues.issueId, outcome.issueId),
          lte(juniorGitHubIssues.updatedAt, outcome.updatedAt),
        ),
      )
      .returning({
        conversationIds: juniorGitHubIssues.conversationIds,
      });
    return {
      applied: updated.length > 0,
      conversationIds: updated[0]?.conversationIds ?? [],
    };
  }

  const inserted = await db
    .insert(juniorGitHubIssues)
    .values({ issueId: outcome.issueId, ...values })
    .onConflictDoUpdate({
      target: juniorGitHubIssues.issueId,
      set: values,
      where: lte(juniorGitHubIssues.updatedAt, outcome.updatedAt),
    })
    .returning({
      conversationIds: juniorGitHubIssues.conversationIds,
    });
  return {
    applied: inserted.length > 0,
    conversationIds: inserted[0]?.conversationIds ?? [],
  };
}

/** Append native conversation ids to an existing Junior-owned issue projection. */
export async function recordGitHubIssueConversations(
  db: GitHubDb,
  input: GitHubIssueConversationsInput,
): Promise<boolean> {
  const association = githubIssueConversationsInputSchema.parse(input);
  const conversationIds = sql.join(
    association.conversationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const updated = await db
    .update(juniorGitHubIssues)
    .set({
      conversationIds: sql`ARRAY(
        SELECT DISTINCT value
        FROM unnest(
          ${juniorGitHubIssues.conversationIds}
          || ARRAY[${conversationIds}]::text[]
        ) AS value
        ORDER BY value
      )`,
    })
    .where(eq(juniorGitHubIssues.issueId, association.issueId))
    .returning({ issueId: juniorGitHubIssues.issueId });
  return updated.length > 0;
}
