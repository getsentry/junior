/**
 * What the GitHub plugin tells Guardian about a shell command: the agent's
 * open pull requests in this work with their work branches, and the
 * audience of each repository in the Workspace or in those pull requests.
 * Each line comes from a template over code-change records, the Workspace
 * record, and GitHub reads through the plugin cache.
 */
import type {
  GuardianFactsContext,
  PluginGuardianCall,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { repositoryAudience } from "./repository-audience.js";
import { githubApi, parseRepo, repoPath } from "./tool-support/github-api.js";

const MAX_PULL_REQUESTS = 10;
const MAX_REPOSITORIES = 10;
const READ_CONCURRENCY = 4;
// A branch of an open pull request rarely changes.
const BRANCH_TTL_MS = 10 * 60 * 1000;
// Only a plain branch name goes into a line.
const BRANCH_NAME = /^[\w./-]{1,100}$/;

const pullRequestSchema = z.object({ head: z.object({ ref: z.string() }) });

async function headBranch(
  ctx: GuardianFactsContext,
  repo: { name: string; owner: string; ref: string },
  number: number,
): Promise<string | undefined> {
  try {
    const branch = await ctx.cache.getOrLoad(
      `pull-request-head:${repo.ref}#${number}`.toLowerCase(),
      async () => {
        const response = await githubApi(ctx.egress, {
          operation: "github.pull_request.get",
          path: `${repoPath(repo)}/pulls/${number}`,
        });
        // A failed read is not an answer, so it is not cached.
        if (!response.ok) {
          throw new Error(
            `GitHub pull request read failed with HTTP ${response.status}`,
          );
        }
        return {
          value: pullRequestSchema.parse(response.body).head.ref,
          ttlMs: BRANCH_TTL_MS,
        };
      },
    );
    return BRANCH_NAME.test(branch) ? branch : undefined;
  } catch {
    return undefined;
  }
}

function repository(name: string) {
  try {
    return parseRepo(name);
  } catch {
    return undefined;
  }
}

/** The `guardian.context` hook of the GitHub plugin. */
export async function githubGuardianContext(
  call: PluginGuardianCall | undefined,
  ctx: GuardianFactsContext,
): Promise<string[]> {
  if (call?.tool !== "bash") return [];
  const conversationIds = await ctx.conversationIds();
  const [changes, workspaceRepos] = await Promise.all([
    conversationIds.length > 0
      ? ctx.codeChanges.list({ conversationIds, state: "open" })
      : Promise.resolve([]),
    ctx.workspaceRepos(),
  ]);
  const pulls = changes.slice(-MAX_PULL_REQUESTS).flatMap((change) => {
    const repo = repository(change.repository.name);
    return repo ? [{ repo, number: change.number }] : [];
  });
  const repos = new Map<string, NonNullable<ReturnType<typeof repository>>>();
  for (const repo of [
    ...workspaceRepos
      .filter((entry) => entry.provider === "github")
      .map((entry) => repository(entry.repo)),
    ...pulls.map((pull) => pull.repo),
  ]) {
    if (repo && repos.size < MAX_REPOSITORIES) {
      repos.set(repo.ref.toLowerCase(), repo);
    }
  }
  const limit = pLimit(READ_CONCURRENCY);
  const [pullLines, repoLines] = await Promise.all([
    limit.map(pulls, async ({ repo, number }) => {
      const branch = await headBranch(ctx, repo, number);
      return branch
        ? `The agent's open pull request ${repo.ref}#${number} in this work has work branch ${branch}.`
        : `The agent's open pull request ${repo.ref}#${number} is in this work.`;
    }),
    limit.map(
      [...repos.values()],
      async (repo) =>
        `Repository ${repo.ref} has audience ${await repositoryAudience(ctx, repo)}.`,
    ),
  ]);
  return [...pullLines, ...repoLines];
}
