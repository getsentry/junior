/**
 * Link a new pull request into a GitHub stack.
 *
 * A pull request whose base is the head branch of another open pull request
 * is stacked work. GitHub stacks merge as one group, rebase the next pull
 * request after a merge, and check each pull request against the trunk. So
 * the create tool links the pull request into a stack instead of leaving a
 * chain of base branches.
 */
import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubApi, repoPath } from "../tool-support/github-api.js";

/** Longest chain of base branches to walk down to the trunk. */
const MAX_STACK_DEPTH = 10;

// The Stacks API needs this version or newer.
const GITHUB_STACKS_API_VERSION = "2026-03-10";

/** The fields of a created pull request that decide if it is stacked work. */
export const stackTargetSchema = z.object({
  number: z.number().int().positive(),
  head: z.object({
    ref: z.string().min(1),
    repo: z.object({ full_name: z.string().min(1) }).nullable(),
  }),
  base: z.object({
    ref: z.string().min(1),
    repo: z.object({
      default_branch: z.string().min(1),
      full_name: z.string().min(1),
    }),
  }),
});
export type GitHubStackTarget = z.infer<typeof stackTargetSchema>;

const openPullRequestsSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    base: z.object({ ref: z.string().min(1) }),
  }),
);

const stackSchema = z.object({
  number: z.number().int().positive(),
  pull_requests: z.array(z.object({ number: z.number().int().positive() })),
});
type GitHubStack = z.infer<typeof stackSchema>;

/** The stack that a created pull request joined. */
export interface GitHubPullRequestStack {
  number: number;
  pull_requests: number[];
}

/**
 * Link a created pull request into a GitHub stack when its base is the head
 * branch of another open pull request. Add it to the stack of that pull
 * request when that one is on top, or create a stack from the chain of base
 * branches down to the trunk. Return the stack, or nothing when the pull
 * request is not stacked work or GitHub cannot stack it. Stacking is
 * optional, so failures never fail pull request creation.
 */
export async function stackGitHubPullRequest(
  ctx: ToolRegistrationHookContext,
  target: GitHubStackTarget,
): Promise<GitHubPullRequestStack | undefined> {
  const repo = target.base.repo.full_name;
  const trunk = target.base.repo.default_branch;
  // Stacks need every branch in one repository. A pull request from the trunk,
  // such as a sync of the trunk into a long-lived branch, is not stacked work.
  if (
    target.base.ref === trunk ||
    target.head.ref === trunk ||
    target.head.repo?.full_name !== repo
  ) {
    return undefined;
  }
  const [owner, name] = repo.split("/");
  const api = repoPath({ owner: owner!, name: name! });
  /** Call GitHub. A rejected call returns nothing and stops stacking. */
  const github = async <T>(
    operation: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T | undefined> => {
    const response = await githubApi(ctx.egress, {
      apiVersion: GITHUB_STACKS_API_VERSION,
      operation,
      path,
      ...(body === undefined ? undefined : { method: "POST", body }),
    });
    if (!response.ok) {
      // The Stacks API answers 404 when the repository cannot use stacks.
      ctx.log.warn("github.pull_request.stack_after_create.rejected", {
        number: target.number,
        operation,
        repo,
        status: response.status,
      });
      return undefined;
    }
    return schema.parse(response.body);
  };
  const result = (stack: GitHubStack): GitHubPullRequestStack => ({
    number: stack.number,
    pull_requests: stack.pull_requests.map((pullRequest) => pullRequest.number),
  });

  try {
    // Bottom to top. Each pull request is based on the head of the one below.
    const chain = [target.number];
    let branch = target.base.ref;
    for (
      let depth = 0;
      depth < MAX_STACK_DEPTH && branch !== trunk;
      depth += 1
    ) {
      const parents = await github(
        "github.pull.list",
        `${api}/pulls?state=open&per_page=2&head=${encodeURIComponent(`${owner}:${branch}`)}`,
        openPullRequestsSchema,
      );
      if (!parents) return undefined;
      // No parent: `branch` is the trunk. Two parents: the chain is ambiguous.
      if (parents.length !== 1) break;
      const parent = parents[0]!;
      // Base branches that loop back are not a stack.
      if (chain.includes(parent.number)) return undefined;
      const stacks = await github(
        "github.stack.read",
        `${api}/stacks?pull_request=${parent.number}`,
        z.array(stackSchema),
      );
      if (!stacks) return undefined;
      const stack = stacks[0];
      if (stack) {
        // A stack is a single chain, so it can only grow from its top.
        if (stack.pull_requests.at(-1)?.number !== parent.number) {
          return undefined;
        }
        const added = await github(
          "github.stack.add",
          `${api}/stacks/${stack.number}/add`,
          stackSchema,
          { pull_requests: chain },
        );
        return added && result(added);
      }
      chain.unshift(parent.number);
      branch = parent.base.ref;
    }
    if (chain.length < 2) return undefined;
    const created = await github(
      "github.stack.create",
      `${api}/stacks`,
      stackSchema,
      { pull_requests: chain },
    );
    return created && result(created);
  } catch (error) {
    ctx.log.warn("github.pull_request.stack_after_create.failed", {
      error: error instanceof Error ? error.message : String(error),
      number: target.number,
      repo,
    });
    return undefined;
  }
}
