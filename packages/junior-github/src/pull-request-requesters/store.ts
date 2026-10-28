import { and, eq, inArray } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequestRequesters } from "../db/schema.js";

/**
 * Save who asked Junior to open a pull request on one head branch.
 * Call it before the pull request exists, so the `opened` webhook can read
 * it. Without a linked GitHub login, the old row for the branch is removed,
 * so a requester from an earlier pull request cannot carry over.
 */
export async function recordGitHubPullRequestRequester(
  db: GitHubDb,
  input: {
    headBranch: string;
    repositoryFullName: string;
    requesterLogin: string | undefined;
  },
): Promise<void> {
  const key = {
    headBranch: input.headBranch,
    repositoryFullName: input.repositoryFullName.toLowerCase(),
  };
  if (!input.requesterLogin) {
    await db
      .delete(juniorGitHubPullRequestRequesters)
      .where(
        and(
          eq(
            juniorGitHubPullRequestRequesters.repositoryFullName,
            key.repositoryFullName,
          ),
          eq(juniorGitHubPullRequestRequesters.headBranch, key.headBranch),
        ),
      );
    return;
  }
  const values = {
    requesterLogin: input.requesterLogin,
    updatedAt: new Date(),
  };
  await db
    .insert(juniorGitHubPullRequestRequesters)
    .values({ ...key, ...values })
    .onConflictDoUpdate({
      target: [
        juniorGitHubPullRequestRequesters.repositoryFullName,
        juniorGitHubPullRequestRequesters.headBranch,
      ],
      set: values,
    });
}

/** Load the saved requester login for each head branch that has one. */
export async function listGitHubPullRequestRequesters(
  db: GitHubDb,
  input: { headBranches: string[]; repositoryFullName: string },
): Promise<Map<string, string>> {
  if (input.headBranches.length === 0) return new Map();
  const rows = await db
    .select({
      headBranch: juniorGitHubPullRequestRequesters.headBranch,
      requesterLogin: juniorGitHubPullRequestRequesters.requesterLogin,
    })
    .from(juniorGitHubPullRequestRequesters)
    .where(
      and(
        eq(
          juniorGitHubPullRequestRequesters.repositoryFullName,
          input.repositoryFullName.toLowerCase(),
        ),
        inArray(juniorGitHubPullRequestRequesters.headBranch, [
          ...new Set(input.headBranches),
        ]),
      ),
    );
  return new Map(rows.map((row) => [row.headBranch, row.requesterLogin]));
}
