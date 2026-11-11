/**
 * Read pull requests, stacks, diffs, and files for host features such as
 * Walkthroughs. Reads go through host egress with Junior's system identity.
 */
import type {
  CodeChangeDiff,
  CodeChangeHooks,
  CodeChangeReadHookContext,
  CodeChangeStack,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubApi } from "./tool-support/github-api.js";

/** Longest chain of base branches to walk in each direction. */
const MAX_STACK_DEPTH = 10;
// The Stacks API needs this version or newer.
const GITHUB_STACKS_API_VERSION = "2026-03-10";

const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  head: z.object({ ref: z.string().min(1), sha: z.string() }),
  base: z.object({ ref: z.string().min(1), sha: z.string() }),
});
type GitHubPull = z.infer<typeof pullSchema>;

const pullListSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    head: z.object({ ref: z.string().min(1) }),
    base: z.object({ ref: z.string().min(1) }),
  }),
);

const stacksSchema = z.array(
  z.object({
    pull_requests: z.array(z.object({ number: z.number().int().positive() })),
  }),
);

const compareSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        previous_filename: z.string().min(1).optional(),
        status: z.string(),
        patch: z.string().optional(),
      }),
    )
    .default([]),
});

const contentSchema = z.object({
  type: z.string(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** What these reads use from the hook context. */
type ReadContext = Pick<CodeChangeReadHookContext, "egress" | "signal">;

/** The host passes these into API paths, so reject anything else. */
function assertPathParts(parts: { repository: string; shas?: string[] }) {
  if (!REPOSITORY.test(parts.repository)) {
    throw new Error(`Invalid GitHub repository ${parts.repository}`);
  }
  for (const sha of parts.shas ?? []) {
    if (!SHA.test(sha)) throw new Error(`Invalid commit SHA ${sha}`);
  }
}

async function readStack(
  ctx: ReadContext & { repository: string; number: number },
): Promise<CodeChangeStack | undefined> {
  assertPathParts({ repository: ctx.repository });
  const pull = await getPull(ctx, ctx.repository, ctx.number);
  if (!pull) return undefined;
  const numbers =
    (await stackFromStacksApi(ctx, ctx.repository, ctx.number)) ??
    (await stackFromBaseBranches(ctx, ctx.repository, pull));
  const pulls = await Promise.all(
    numbers.map(async (number) => {
      if (number === pull.number) return pull;
      const other = await getPull(ctx, ctx.repository, number);
      if (!other) {
        throw new Error(`GitHub pull request #${number} of the stack is gone`);
      }
      return other;
    }),
  );
  // A merged or closed layer needs no review. The requested one stays.
  const open = pulls.filter(
    (p) => p.number === pull.number || p.state === "open",
  );
  return {
    codeChanges: open.map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      url: p.html_url,
      headSha: p.head.sha,
      baseSha: p.base.sha,
      additions: p.additions,
      deletions: p.deletions,
    })),
  };
}

/**
 * Ask the Stacks API. Its `pull_requests` list is bottom first: each pull
 * request's base is the head branch of the one before it.
 * Return nothing when the repository cannot use stacks (404) or the pull
 * request is not in a stack.
 */
async function stackFromStacksApi(
  ctx: ReadContext,
  repository: string,
  number: number,
): Promise<number[] | undefined> {
  const response = await githubApi(ctx.egress, {
    apiVersion: GITHUB_STACKS_API_VERSION,
    operation: "github.stack.read",
    path: `/repos/${repository}/stacks?pull_request=${number}`,
    signal: ctx.signal,
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub stack read failed with HTTP ${response.status}`);
  }
  const stack = stacksSchema.parse(response.body)[0];
  return stack?.pull_requests.map((p) => p.number);
}

/**
 * Walk base branches without the Stacks API. A pull request whose base is
 * another open pull request's head is stacked on it. Walk down to the trunk
 * and up to the top, and stop where the chain is ambiguous.
 */
async function stackFromBaseBranches(
  ctx: ReadContext,
  repository: string,
  pull: GitHubPull,
): Promise<number[]> {
  const owner = repository.split("/")[0]!;
  const chain = [pull.number];
  let branch = pull.base.ref;
  for (let depth = 0; depth < MAX_STACK_DEPTH; depth += 1) {
    const parents = await listOpenPulls(
      ctx,
      repository,
      `head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    // No parent: `branch` is the trunk. Two parents: the chain is ambiguous.
    if (parents.length !== 1) break;
    chain.unshift(parents[0]!.number);
    branch = parents[0]!.base.ref;
  }
  branch = pull.head.ref;
  for (let depth = 0; depth < MAX_STACK_DEPTH; depth += 1) {
    const children = await listOpenPulls(
      ctx,
      repository,
      `base=${encodeURIComponent(branch)}`,
    );
    // Two children fork the chain, so stop at this pull request.
    if (children.length !== 1) break;
    chain.push(children[0]!.number);
    branch = children[0]!.head.ref;
  }
  return chain;
}

async function readDiff(
  ctx: ReadContext & {
    repository: string;
    baseSha: string;
    headSha: string;
  },
): Promise<CodeChangeDiff> {
  assertPathParts({
    repository: ctx.repository,
    shas: [ctx.baseSha, ctx.headSha],
  });
  // Compare the exact commits, so a push during generation cannot change
  // what the Walkthrough describes. Three dots diff from the merge base,
  // which is what a pull request shows.
  const response = await githubApi(ctx.egress, {
    operation: "github.compare.read",
    path: `/repos/${ctx.repository}/compare/${ctx.baseSha}...${ctx.headSha}`,
    signal: ctx.signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub compare failed with HTTP ${response.status}`);
  }
  return {
    files: compareSchema.parse(response.body).files.map((file) => ({
      path: file.filename,
      ...(file.previous_filename
        ? { previousPath: file.previous_filename }
        : undefined),
      status: fileStatus(file.status),
      ...(file.patch === undefined ? undefined : { patch: file.patch }),
    })),
  };
}

function fileStatus(status: string): CodeChangeDiff["files"][number]["status"] {
  if (status === "added" || status === "removed" || status === "renamed") {
    return status;
  }
  // GitHub also reports "copied", "changed", and "unchanged".
  return "modified";
}

async function readFile(
  ctx: ReadContext & {
    repository: string;
    sha: string;
    path: string;
  },
): Promise<string | undefined> {
  assertPathParts({ repository: ctx.repository, shas: [ctx.sha] });
  const path = ctx.path.split("/").map(encodeURIComponent).join("/");
  const response = await githubApi(ctx.egress, {
    operation: "github.content.read",
    path: `/repos/${ctx.repository}/contents/${path}?ref=${ctx.sha}`,
    signal: ctx.signal,
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub content read failed with HTTP ${response.status}`);
  }
  const content = contentSchema.parse(response.body);
  // Directories and files over 1 MB come back without base64 content.
  if (content.type !== "file" || content.encoding !== "base64") {
    return undefined;
  }
  return Buffer.from(content.content ?? "", "base64").toString("utf8");
}

async function getPull(
  ctx: ReadContext,
  repository: string,
  number: number,
): Promise<GitHubPull | undefined> {
  const response = await githubApi(ctx.egress, {
    operation: "github.pull.get",
    path: `/repos/${repository}/pulls/${number}`,
    signal: ctx.signal,
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `GitHub pull request read failed with HTTP ${response.status}`,
    );
  }
  return pullSchema.parse(response.body);
}

async function listOpenPulls(
  ctx: ReadContext,
  repository: string,
  filter: string,
) {
  const response = await githubApi(ctx.egress, {
    operation: "github.pull.list",
    path: `/repos/${repository}/pulls?state=open&per_page=2&${filter}`,
    signal: ctx.signal,
  });
  if (!response.ok) {
    throw new Error(
      `GitHub pull request list failed with HTTP ${response.status}`,
    );
  }
  return pullListSchema.parse(response.body);
}

/** Code change reads backed by the GitHub REST API. */
export const githubCodeChangeHooks = {
  readStack,
  readDiff,
  readFile,
} satisfies CodeChangeHooks;
