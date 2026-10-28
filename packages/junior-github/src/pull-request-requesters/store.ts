import { and, eq, inArray } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequestRequesters } from "../db/schema.js";

/**
 * Save who asked Junior to open a pull request on one head branch.
 * Call it before the pull request exists, so the `opened` webhook can read
 * it. Without a linked GitHub login, the old row for the branch is removed,
 * so a requester from an earlier pull request cannot carry over. Returns the
 * login that the row had before, so a caller can restore it when GitHub
 * rejects the create.
 */
export async function recordGitHubPullRequestRequester(
  db: GitHubDb,
  input: {
    headBranch: string;
    repositoryFullName: string;
    requesterLogin: string | undefined;
  },
): Promise<string | undefined> {
  const key = {
    headBranch: input.headBranch,
    repositoryFullName: input.repositoryFullName.toLowerCase(),
  };
  const keyMatches = and(
    eq(
      juniorGitHubPullRequestRequesters.repositoryFullName,
      key.repositoryFullName,
    ),
    eq(juniorGitHubPullRequestRequesters.headBranch, key.headBranch),
  );
  const [previous] = await db
    .select({
      requesterLogin: juniorGitHubPullRequestRequesters.requesterLogin,
    })
    .from(juniorGitHubPullRequestRequesters)
    .where(keyMatches);
  if (!input.requesterLogin) {
    await db.delete(juniorGitHubPullRequestRequesters).where(keyMatches);
    return previous?.requesterLogin;
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
  return previous?.requesterLogin;
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
