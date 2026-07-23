import { z } from "zod";
import type { GitHubPullRequestCommitComposition } from "../db/schema.js";
import { botLoginFromEmail } from "../webhooks/ownership.js";

const canonicalCommitSchema = z
  .object({
    authorEmail: z.string().nullable(),
    authorLogin: z.string().nullable(),
  })
  .strict();

const providerCommitSchema = z
  .object({
    author: z.object({ login: z.string() }).passthrough().nullable(),
    commit: z
      .object({
        author: z.object({ email: z.string() }).passthrough().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

const commitPageSchema = z.array(providerCommitSchema).transform((commits) =>
  commits.map((commit) =>
    canonicalCommitSchema.parse({
      authorEmail: commit.commit.author?.email ?? null,
      authorLogin: commit.author?.login ?? null,
    }),
  ),
);
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const MAX_LISTED_COMMITS = 250;

/** Classify whether every Git author in a PR commit list is Junior's bot. */
export async function classifyGitHubPullRequestCommitComposition(args: {
  botEmail: string;
  loadPage(page: number, perPage: number): Promise<unknown>;
}): Promise<GitHubPullRequestCommitComposition | undefined> {
  const botEmail = args.botEmail.trim().toLowerCase();
  const botLogin = botLoginFromEmail(botEmail)?.toLowerCase();
  if (!botEmail || !botLogin) {
    throw new Error(
      "The configured GitHub App bot email cannot classify pull request commits",
    );
  }

  let foundCommit = false;
  let inspectedCommits = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const commits = commitPageSchema.parse(
      await args.loadPage(page, PAGE_SIZE),
    );
    inspectedCommits += commits.length;
    for (const commit of commits) {
      foundCommit = true;
      const authorLogin = commit.authorLogin?.trim().toLowerCase();
      const authorEmail = commit.authorEmail?.trim().toLowerCase();
      if (authorLogin !== botLogin && authorEmail !== botEmail) {
        return "mixed";
      }
    }
    if (inspectedCommits >= MAX_LISTED_COMMITS) return undefined;
    if (commits.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) return undefined;
  }
  return foundCommit ? "junior_only" : undefined;
}
