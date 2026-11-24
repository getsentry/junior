/**
 * Link cards for GitHub issues and pull requests, such as a pasted
 * `https://github.com/getsentry/junior/pull/12`. They show the same card as
 * an issue or pull request that a GitHub tool read.
 *
 * The viewer's linked GitHub account must see the repository first. Then
 * the App reads the object, cached per object for every viewer. A viewer
 * without access gets the public web page card of the link, which shows
 * only what GitHub shows anyone signed out.
 *
 * A page of links, such as one Inbox page, reads its objects with one
 * GraphQL query first (`preload`). A pull request card splits its title by
 * the change types of the repository's `.github/release.yml`.
 */
import type {
  ObjectAnnotation,
  ObjectLinkContext,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { githubObjectAnnotation } from "./annotations.js";
import {
  DEFAULT_CODE_CHANGE_CATEGORIES,
  parseCodeChangeTitle,
  type CodeChangeCategory,
} from "./code-change-titles/parse.js";
import { parseReleaseCategories } from "./code-change-titles/release-config.js";
import { githubObjectCards } from "./graphql-documents.js";
import {
  githubObjectFacts,
  withGitHubPreviewImages,
  type CodeChangeFacts,
} from "./object-facts.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubApi, repoPath } from "./tool-support/github-api.js";

// The same time as the card cache, so a changed object shows within a minute.
const OBJECT_CACHE_TTL_MS = 60_000;
// The change types of a repository change rarely.
const RELEASE_CONFIG_TTL_MS = 60 * 60_000;
// Objects that one GraphQL query reads, under GitHub's query cost limits.
const PRELOAD_BATCH_SIZE = 50;
// Repository access checks of one page that run at once.
const REPOSITORY_CHECKS = 4;

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO_PATTERN = /^[\w.-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9]\d{0,9}$/;

const objectSchema = z.object({
  html_url: z.string(),
  number: z.number().int().positive(),
  state: z.string(),
  title: z.string(),
});
const issueSchema = objectSchema.extend({
  // The issues API also returns pull requests, with this field set.
  pull_request: z.unknown().optional(),
});
const pullRequestSchema = objectSchema.extend({
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
});

const contentsSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});

const logins = z
  .object({ nodes: z.array(z.object({ login: z.string() }).nullable()) })
  .transform(({ nodes }) => nodes.flatMap((node) => (node ? [node] : [])));
// The GraphQL fields of `githubObjectCards`, mapped to the REST bodies that
// the cards read, so both reads give the same card.
const graphqlObjectSchema = z.discriminatedUnion("__typename", [
  z
    .object({
      __typename: z.literal("Issue"),
      assignees: logins,
      body: z.string().nullable(),
      labels: z
        .object({ nodes: z.array(z.object({ name: z.string() }).nullable()) })
        .transform(({ nodes }) =>
          nodes.flatMap((node) => (node ? [node] : [])),
        ),
      number: z.number().int().positive(),
      // An alias: an Issue state and a PullRequest state have other types.
      issueState: z.string(),
      title: z.string(),
      updatedAt: z.string(),
      url: z.string(),
    })
    .transform(({ issueState, updatedAt, url, ...issue }) => ({
      assignees: issue.assignees,
      body: issue.body,
      html_url: url,
      labels: issue.labels,
      number: issue.number,
      state: issueState.toLowerCase(),
      title: issue.title,
      updated_at: updatedAt,
    })),
  z
    .object({
      __typename: z.literal("PullRequest"),
      additions: z.number().int().nonnegative(),
      author: z.object({ login: z.string() }).nullable(),
      baseRefName: z.string(),
      body: z.string().nullable(),
      changedFiles: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      headRefName: z.string(),
      isDraft: z.boolean(),
      mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
      merged: z.boolean(),
      number: z.number().int().positive(),
      reviewRequests: z
        .object({
          nodes: z.array(
            z
              .object({
                requestedReviewer: z
                  .object({ login: z.string().optional() })
                  .nullable(),
              })
              .nullable(),
          ),
        })
        .nullable(),
      reviewDecision: z
        .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
        .nullish(),
      latestOpinionatedReviews: z
        .object({
          nodes: z.array(z.object({ state: z.string() }).nullable()),
        })
        .nullish(),
      state: z.string(),
      title: z.string(),
      updatedAt: z.string(),
      url: z.string(),
    })
    .transform((pull) => ({
      additions: pull.additions,
      base: { ref: pull.baseRefName },
      body: pull.body,
      changed_files: pull.changedFiles,
      deletions: pull.deletions,
      draft: pull.isDraft,
      head: { ref: pull.headRefName },
      html_url: pull.url,
      mergeable:
        pull.mergeable === "UNKNOWN" ? null : pull.mergeable === "MERGEABLE",
      merged: pull.merged,
      number: pull.number,
      pull_request: {},
      requested_reviewers: (pull.reviewRequests?.nodes ?? []).flatMap(
        (node) => {
          const login = node?.requestedReviewer?.login;
          return login ? [{ login }] : [];
        },
      ),
      review: pullRequestReview(pull),
      // GitHub GraphQL says `MERGED`; REST says `closed` with `merged`.
      state: pull.state === "OPEN" ? "open" : "closed",
      title: pull.title,
      updated_at: pull.updatedAt,
      user: pull.author,
    })),
]);
/**
 * Return GitHub's review decision. A repository that requires no review has
 * none, so the latest review of each writer decides: approved when one
 * approves and none asks for changes.
 */
function pullRequestReview(pull: {
  latestOpinionatedReviews?:
    | { nodes: Array<{ state: string } | null> }
    | null
    | undefined;
  reviewDecision?:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "REVIEW_REQUIRED"
    | null
    | undefined;
}): "approved" | "changes_requested" | "required" | undefined {
  if (pull.reviewDecision === "APPROVED") return "approved";
  if (pull.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (pull.reviewDecision === "REVIEW_REQUIRED") return "required";
  const states = (pull.latestOpinionatedReviews?.nodes ?? []).map(
    (review) => review?.state,
  );
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  return states.includes("APPROVED") ? "approved" : undefined;
}

const graphqlCardsSchema = z.object({
  data: z.record(
    z.string(),
    z
      .object({
        releaseConfig: z.object({ text: z.string().nullable() }).nullable(),
      })
      .catchall(z.unknown())
      .nullable(),
  ),
});

interface GitHubObjectLink {
  kind: "issue" | "pull_request";
  name: string;
  number: string;
  owner: string;
}

function parseLink(url: URL): GitHubObjectLink | undefined {
  const [owner = "", name = "", path, number = ""] = url.pathname
    .split("/")
    .filter(Boolean);
  if (
    !OWNER_PATTERN.test(owner) ||
    !REPO_PATTERN.test(name) ||
    !NUMBER_PATTERN.test(number)
  ) {
    return undefined;
  }
  return {
    kind: path === "pull" ? "pull_request" : "issue",
    name,
    number,
    owner,
  };
}

/** Parse the object link of an API `html_url`. */
function htmlUrlLink(htmlUrl: string): GitHubObjectLink | undefined {
  const url = URL.parse(htmlUrl);
  return url?.host === "github.com" ? parseLink(url) : undefined;
}

// A transferred issue or a renamed repository answers from its new place.
function repoRef(htmlUrl: string, link: GitHubObjectLink): string {
  const { owner, name } = htmlUrlLink(htmlUrl) ?? link;
  return `${owner}/${name}`;
}

function issueCard(link: GitHubObjectLink, body: unknown): ObjectAnnotation {
  const issue = issueSchema.parse(body);
  return githubObjectAnnotation({
    ...githubObjectFacts("task", body),
    repo: repoRef(issue.html_url, link),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    objectType: "task",
    status: issue.state,
  });
}

/**
 * Add the title parts to code change facts. The preview images are packed
 * again after them, so the facts stay in the 4 KiB limit.
 */
function withTitleParts(
  facts: CodeChangeFacts,
  titleParts: NonNullable<CodeChangeFacts["titleParts"]>,
): CodeChangeFacts {
  const { previewImageUrls = [], ...rest } = facts;
  return withGitHubPreviewImages({ ...rest, titleParts }, previewImageUrls);
}

function pullRequestCard(
  link: GitHubObjectLink,
  body: unknown,
  categories: readonly CodeChangeCategory[],
): ObjectAnnotation {
  const pull = pullRequestSchema.parse(body);
  const card = githubObjectFacts("code_change", body);
  const titleParts = parseCodeChangeTitle(pull.title, categories);
  return githubObjectAnnotation({
    ...card,
    ...(titleParts && card.facts?.type === "code_change"
      ? { facts: withTitleParts(card.facts, titleParts) }
      : undefined),
    repo: repoRef(pull.html_url, link),
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    objectType: "code_change",
    status: pull.merged
      ? "merged"
      : pull.state === "open" && pull.draft
        ? "draft"
        : pull.state,
  });
}

function releaseConfigKey(link: Pick<GitHubObjectLink, "name" | "owner">) {
  return `release-config:${link.owner}/${link.name}`.toLowerCase();
}

/**
 * Read the text of a repository's `.github/release.yml` with the App, or
 * an empty text when it has none. A failed read is not cached.
 */
async function readReleaseConfig(
  ctx: ObjectLinkContext,
  link: Pick<GitHubObjectLink, "name" | "owner">,
): Promise<string> {
  return await ctx.cache.getOrLoad(releaseConfigKey(link), async () => {
    const response = await githubApi(ctx.egress, {
      apiVersion: "2022-11-28",
      operation: "github.repository.release-config.get",
      path: `${repoPath(link)}/contents/.github/release.yml`,
    });
    if (response.status === 404) {
      return { value: "", ttlMs: RELEASE_CONFIG_TTL_MS };
    }
    const file = contentsSchema.safeParse(response.body);
    if (!response.ok || !file.success) {
      throw new Error(
        `GitHub release config read failed with HTTP ${response.status}`,
      );
    }
    return {
      value: Buffer.from(file.data.content, "base64").toString("utf8"),
      ttlMs: RELEASE_CONFIG_TTL_MS,
    };
  });
}

/** The change types of a repository. The defaults when the read fails. */
async function readCategories(
  ctx: ObjectLinkContext,
  link: Pick<GitHubObjectLink, "name" | "owner">,
): Promise<readonly CodeChangeCategory[]> {
  try {
    const text = await readReleaseConfig(ctx, link);
    return text ? parseReleaseCategories(text) : DEFAULT_CODE_CHANGE_CATEGORIES;
  } catch (error) {
    // The title parts are optional, so the card still shows.
    ctx.log.warn("GitHub release config read failed", {
      error: error instanceof Error ? error.message : String(error),
      repository: `${link.owner}/${link.name}`,
    });
    return DEFAULT_CODE_CHANGE_CATEGORIES;
  }
}

function objectKey(link: GitHubObjectLink): string {
  const collection = link.kind === "issue" ? "issues" : "pulls";
  return `${collection}:${link.owner}/${link.name}#${link.number}`.toLowerCase();
}

/** Read the object with the App. Nothing for a missing or deleted one. */
async function readObject(
  ctx: ObjectLinkContext,
  link: GitHubObjectLink,
): Promise<ObjectAnnotation | null> {
  const collection = link.kind === "issue" ? "issues" : "pulls";
  return await ctx.cache.getOrLoad(objectKey(link), async () => {
    const response = await githubApi(ctx.egress, {
      followRedirects: true,
      operation: link.kind === "issue" ? "github.issue.get" : "github.pull.get",
      path: `${repoPath(link)}/${collection}/${link.number}`,
    });
    // GitHub answers 404 for a missing object, and 410 for a deleted issue.
    if (response.status === 404 || response.status === 410) {
      return { value: null, ttlMs: OBJECT_CACHE_TTL_MS };
    }
    if (!response.ok) {
      throw new Error(
        `GitHub ${link.kind} lookup failed with HTTP ${response.status}`,
      );
    }
    if (link.kind === "pull_request") {
      const pull = pullRequestSchema.parse(response.body);
      return {
        value: pullRequestCard(
          link,
          response.body,
          await readCategories(ctx, htmlUrlLink(pull.html_url) ?? link),
        ),
        ttlMs: OBJECT_CACHE_TTL_MS,
      };
    }
    // GitHub opens a pull request at its issue URL too, such as a linked
    // `owner/repo#12`. Only the pulls API has its draft and merge state.
    const value =
      issueSchema.parse(response.body).pull_request === undefined
        ? issueCard(link, response.body)
        : await readObject(ctx, { ...link, kind: "pull_request" });
    return { value, ttlMs: OBJECT_CACHE_TTL_MS };
  });
}

/** Return the card of one object of a `githubObjectCards` reply. */
function graphqlCard(
  link: GitHubObjectLink,
  value: unknown,
  categories: readonly CodeChangeCategory[],
): ObjectAnnotation | undefined {
  const parsed = graphqlObjectSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return "draft" in parsed.data
    ? pullRequestCard(
        { ...link, kind: "pull_request" },
        parsed.data,
        categories,
      )
    : issueCard(link, parsed.data);
}

/**
 * Read the objects of many links with GraphQL, one query for each batch,
 * into the object cache that `readObject` reads. Only the repositories that
 * the viewer can see are read, the same as `canViewLink`. A missing object,
 * such as a transferred issue, is not cached, so its REST read follows the
 * move.
 */
async function preloadLinks(ctx: ObjectLinkContext, urls: URL[]) {
  const byRepository = new Map<string, GitHubObjectLink[]>();
  for (const url of urls) {
    const link = parseLink(url);
    if (!link) continue;
    const key = `${link.owner}/${link.name}`.toLowerCase();
    byRepository.set(key, [...(byRepository.get(key) ?? []), link]);
  }
  const visible = await pLimit(REPOSITORY_CHECKS).map(
    [...byRepository.values()],
    async (links) => await viewerCanSeeRepository(ctx, links[0]!),
  );
  for (const [i, key] of [...byRepository.keys()].entries()) {
    if (!visible[i]) byRepository.delete(key);
  }
  const batches: GitHubObjectLink[][][] = [[]];
  let size = 0;
  for (const links of byRepository.values()) {
    for (let start = 0; start < links.length; start += PRELOAD_BATCH_SIZE) {
      const chunk = links.slice(start, start + PRELOAD_BATCH_SIZE);
      if (size + chunk.length > PRELOAD_BATCH_SIZE) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1)!.push(chunk);
      size += chunk.length;
    }
  }
  for (const repositories of batches) {
    if (repositories.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- Batches run one at a time, under GitHub's rate limits.
    const response = await githubApi(ctx.egress, {
      body: {
        ...githubObjectCards(repositories.map((links) => links.length)),
        variables: Object.fromEntries(
          repositories.flatMap((links, r): Array<[string, number | string]> => [
            [`o${r}`, links[0]!.owner],
            [`m${r}`, links[0]!.name],
            ...links.map((link, i): [string, number] => [
              `n${r}_${i}`,
              Number(link.number),
            ]),
          ]),
        ),
      },
      method: "POST",
      operation: "github.objects.cards.get",
      path: "/graphql",
    });
    if (!response.ok) {
      throw new Error(
        `GitHub object cards lookup failed with HTTP ${response.status}`,
      );
    }
    const { data } = graphqlCardsSchema.parse(response.body);
    /* oxlint-disable no-await-in-loop -- Cache writes of one reply; each is one state write. */
    for (const [r, links] of repositories.entries()) {
      const repository = data[`r${r}`];
      if (!repository) continue;
      const config = repository.releaseConfig?.text ?? "";
      await ctx.cache.getOrLoad(releaseConfigKey(links[0]!), async () => ({
        value: config,
        ttlMs: RELEASE_CONFIG_TTL_MS,
      }));
      const categories = config
        ? parseReleaseCategories(config)
        : DEFAULT_CODE_CHANGE_CATEGORIES;
      for (const [i, link] of links.entries()) {
        const card = graphqlCard(link, repository[`n${r}_${i}`], categories);
        if (!card) continue;
        await ctx.cache.getOrLoad(objectKey(link), async () => ({
          value: card,
          ttlMs: OBJECT_CACHE_TTL_MS,
        }));
      }
    }
    /* oxlint-enable no-await-in-loop */
  }
}

async function canViewLink(ctx: ObjectLinkContext, url: URL): Promise<boolean> {
  const link = parseLink(url);
  if (!link || !(await viewerCanSeeRepository(ctx, link))) return false;
  const card = await readObject(ctx, link);
  if (!card) return true;
  // A transferred issue or a renamed repository redirects, so the card can
  // come from another repository. The viewer must see that one too.
  const source = card.url ? htmlUrlLink(card.url) : undefined;
  return Boolean(source && (await viewerCanSeeRepository(ctx, source)));
}

async function resolveLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const link = parseLink(url);
  return (link && (await readObject(ctx, link))) ?? undefined;
}

/**
 * GitHub issue links, such as `https://github.com/owner/repo/issues/12`.
 * A pull request at its issue URL shows the pull request card.
 */
export const githubIssueLinks: PluginObjectLinkDefinition = {
  canView: canViewLink,
  filters: [{ host: "github.com", pathPattern: "/*/*/issues/*" }],
  objectTypes: ["task", "code_change"],
  preload: preloadLinks,
  readTool: (object) =>
    object.objectType === "code_change"
      ? "github_getPullRequest"
      : "github_getIssue",
  resolve: resolveLink,
  webPageFallback: true,
};

/** GitHub pull request links, such as `https://github.com/owner/repo/pull/12`. */
export const githubPullRequestLinks: PluginObjectLinkDefinition = {
  canView: canViewLink,
  filters: [{ host: "github.com", pathPattern: "/*/*/pull/*" }],
  objectTypes: ["code_change"],
  preload: preloadLinks,
  readTool: () => "github_getPullRequest",
  resolve: resolveLink,
  webPageFallback: true,
};
