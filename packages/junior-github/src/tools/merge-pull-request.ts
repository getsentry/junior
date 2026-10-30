import {
  type Actor,
  type PluginEgress,
  type PluginLogger,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  type GitHubMergeCommit,
  type GitHubMergeReview,
  gitHubPullRequestMergeDenial,
} from "../pull-request-merge-policy.js";
import {
  linkedGitHubLogin,
  resolveGitHubRequester,
  type GitHubRequester,
} from "../tool-support/attribution.js";
import { botUserIdFromEmail } from "../webhooks/ownership.js";

/** GitHub lists at most 250 commits for one pull request. */
const MAX_COMMIT_PAGES = 3;
const MAX_REVIEW_PAGES = 10;
const PAGE_SIZE = 100;

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .describe(
        "Full head commit SHA that you checked. GitHub refuses the merge if the head changed.",
      ),
    mergeMethod: z
      .enum(["merge", "squash", "rebase"])
      .optional()
      .describe("Merge method. Defaults to squash."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("mergePullRequest"),
  repo: z.string(),
  number: z.number(),
  merged: z.boolean(),
  sha: z.string(),
});
interface Result extends PluginToolOutput {
  target: "mergePullRequest";
  repo: string;
  number: number;
  merged: boolean;
  sha: string;
}

const accountSchema = z
  .object({ id: z.number(), type: z.string() })
  .passthrough()
  .nullable();

const pullRequestSchema = z
  .object({
    draft: z.boolean().optional().default(false),
    head: z.object({ sha: z.string() }).passthrough(),
    mergeable_state: z.string().optional(),
    merged: z.boolean().optional().default(false),
    state: z.string(),
    user: accountSchema,
  })
  .passthrough();

const reviewsSchema = z.array(
  z
    .object({
      commit_id: z.string().nullable().optional(),
      state: z.string(),
      user: accountSchema.optional(),
    })
    .passthrough(),
);

const gitIdentitySchema = z
  .object({ email: z.string().optional() })
  .passthrough()
  .nullable()
  .optional();
const commitsSchema = z.array(
  z
    .object({
      author: z.object({ id: z.number() }).passthrough().nullable().optional(),
      committer: z
        .object({ id: z.number() })
        .passthrough()
        .nullable()
        .optional(),
      commit: z
        .object({ author: gitIdentitySchema, committer: gitIdentitySchema })
        .passthrough(),
    })
    .passthrough(),
);

const permissionSchema = z.object({ permission: z.string() }).passthrough();

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubError(body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return "GitHub request failed";
}

/**
 * Merge an allowlisted pull request after the merge policy passes.
 *
 * Register this tool only when the app lists merge repositories.
 */
export function createGitHubMergePullRequestTool(
  ctx: {
    actor?: Actor;
    egress: PluginEgress;
    log: PluginLogger;
    users: { resolveActor(): Promise<GitHubRequester | undefined> };
  },
  options: { botEmail: string | undefined; repositories: ReadonlySet<string> },
) {
  async function read(
    operation: string,
    path: string,
    notFound: string,
  ): Promise<unknown> {
    const response = await ctx.egress.fetch({
      provider: "github",
      operation,
      request: new Request(`https://api.github.com${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }),
    });
    const body = await readJson(response);
    if (response.status === 404) {
      throw new PluginToolInputError(notFound);
    }
    if (!response.ok) {
      throw new Error(
        `GitHub ${operation} failed with HTTP ${response.status}: ${githubError(body)}`,
      );
    }
    return body;
  }

  async function readPages<T>(
    operation: string,
    path: string,
    maxPages: number,
    schema: z.ZodType<T[]>,
    label: string,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const pageItems = schema.parse(
        await read(
          operation,
          `${path}?per_page=${PAGE_SIZE}&page=${page}`,
          "GitHub pull request was not found.",
        ),
      );
      items.push(...pageItems);
      if (pageItems.length < PAGE_SIZE) return items;
    }
    throw new PluginToolInputError(
      `The pull request has more ${label} than you can check before merging.`,
    );
  }

  return definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Merge a GitHub pull request in a repository where the app allows merging. A pull request you authored needs a person's approval on its current head. A pull request a person authored needs your own review on its current head and no commits from you. The requester needs write access. Pass the head SHA that you checked.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      if (!options.repositories.has(repo.ref.toLowerCase())) {
        throw new PluginToolInputError(
          `Merging is not enabled for ${repo.ref}. The app must list the repository in its GitHub merge configuration.`,
        );
      }
      const botUserId = botUserIdFromEmail(options.botEmail);
      if (!options.botEmail || botUserId === undefined) {
        throw new Error("GitHub App bot identity is not configured.");
      }
      const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
      const pullPath = `${repoPath}/pulls/${input.number}`;

      const requesterLogin = linkedGitHubLogin(
        (await resolveGitHubRequester(ctx))?.user,
      );
      if (!requesterLogin) {
        throw new PluginToolInputError(
          "The requester must link a GitHub account before you can merge for them.",
        );
      }

      const [permission, pullRequest, reviews, commits] = await Promise.all([
        read(
          "github.repo.collaborator-permission.get",
          `${repoPath}/collaborators/${encodeURIComponent(requesterLogin)}/permission`,
          `${requesterLogin} is not a collaborator on ${repo.ref}.`,
        ).then((body) => permissionSchema.parse(body).permission),
        read(
          "github.pull.get",
          pullPath,
          "GitHub pull request was not found.",
        ).then((body) => pullRequestSchema.parse(body)),
        readPages(
          "github.pull.reviews",
          `${pullPath}/reviews`,
          MAX_REVIEW_PAGES,
          reviewsSchema,
          "reviews",
        ),
        readPages(
          "github.pull.commits",
          `${pullPath}/commits`,
          MAX_COMMIT_PAGES,
          commitsSchema,
          "commits",
        ),
      ]);

      const denial = gitHubPullRequestMergeDenial({
        botEmail: options.botEmail,
        botUserId,
        commits: commits.map(
          (commit): GitHubMergeCommit => ({
            authorEmail: commit.commit.author?.email,
            authorId: commit.author?.id,
            committerEmail: commit.commit.committer?.email,
            committerId: commit.committer?.id,
          }),
        ),
        expectedHeadSha: input.headSha,
        pullRequest: {
          author: pullRequest.user,
          draft: pullRequest.draft,
          headSha: pullRequest.head.sha,
          merged: pullRequest.merged,
          mergeableState: pullRequest.mergeable_state,
          state: pullRequest.state,
        },
        requesterPermission: permission,
        reviews: reviews.map(
          (review): GitHubMergeReview => ({
            commitId: review.commit_id ?? null,
            reviewer: review.user ?? null,
            state: review.state,
          }),
        ),
      });
      if (denial) {
        throw new PluginToolInputError(`Merge refused: ${denial}`);
      }

      const response = await ctx.egress.fetch({
        provider: "github",
        operation: "github.pull.merge",
        request: new Request(`https://api.github.com${pullPath}/merge`, {
          method: "PUT",
          headers: {
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            merge_method: input.mergeMethod ?? "squash",
            sha: input.headSha.toLowerCase(),
          }),
        }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        const message = `GitHub pull request merge failed with HTTP ${response.status}: ${githubError(body)}`;
        // 405 not mergeable, 409 head changed, 422 invalid input.
        if ([404, 405, 409, 422].includes(response.status)) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const merged = z
        .object({ merged: z.boolean(), sha: z.string() })
        .passthrough()
        .parse(body);
      return {
        target: "mergePullRequest",
        repo: repo.ref,
        number: input.number,
        merged: merged.merged,
        sha: merged.sha,
      };
    },
  });
}
