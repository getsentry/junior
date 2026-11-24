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
 * A pull request card splits its title by the change types of the
 * repository's `.github/release.yml`.
 */
import type {
  ObjectAnnotation,
  ObjectLinkContext,
  ObjectLinkPrefetchOutcome,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubObjectAnnotation } from "./annotations.js";
import {
  DEFAULT_CODE_CHANGE_CATEGORIES,
  parseCodeChangeTitle,
  type CodeChangeCategory,
} from "./code-change-titles/parse.js";
import { parseReleaseCategories } from "./code-change-titles/release-config.js";
import {
  GITHUB_ISSUE_CACHE,
  githubObjectCacheOptions,
  githubIssueFieldsSchema,
  githubObjectCacheKey,
  githubPullRequestEntry,
  githubPullRequestFieldsSchema,
  type GitHubIssueFields,
  type GitHubPullRequestFields,
} from "./object-cache.js";
import {
  githubObjectFacts,
  withGitHubPreviewImages,
  type CodeChangeFacts,
} from "./object-facts.js";
import { prefetchGitHubPullRequests } from "./pull-request-prefetch.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubApi, repoPath } from "./tool-support/github-api.js";

// The change types of a repository change rarely.
const RELEASE_CONFIG_TTL_MS = 60 * 60_000;

const contentsSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO_PATTERN = /^[\w.-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9]\d{0,9}$/;
// The load of a card that the page read ran out of time for.
const OUT_OF_TIME = new Error("The page read ran out of time for this card");

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

function issueCard(
  link: GitHubObjectLink,
  issue: GitHubIssueFields,
): ObjectAnnotation {
  return githubObjectAnnotation({
    ...githubObjectFacts("task", issue),
    repo: repoRef(issue.html_url, link),
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    objectType: "task",
    status: issue.state,
  });
}

const TITLE_PART_MAX_LENGTH = 160;

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
  pull: GitHubPullRequestFields,
  categories: readonly CodeChangeCategory[],
): ObjectAnnotation {
  const card = githubObjectFacts("code_change", pull);
  const parsed = parseCodeChangeTitle(pull.title, categories);
  // Card facts cap a title part at 160 characters, and a longer one would
  // drop the whole card, so such a title shows without its parts.
  const titleParts =
    parsed &&
    (parsed.scope?.length ?? 0) <= TITLE_PART_MAX_LENGTH &&
    (parsed.type?.length ?? 0) <= TITLE_PART_MAX_LENGTH
      ? parsed
      : undefined;
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

/**
 * Read the object fields through the cache, or with the App. Nothing for a
 * missing or deleted object.
 */
async function readFields<T>(
  ctx: ObjectLinkContext,
  link: GitHubObjectLink,
  schema: z.ZodType<T>,
  entry: (value: T) => { staleIfError: true; ttlMs: number; value: T },
): Promise<T | null> {
  const collection = link.kind === "issue" ? "issues" : "pulls";
  const key = githubObjectCacheKey(
    collection,
    `${link.owner}/${link.name}`,
    link.number,
  );
  const options = githubObjectCacheOptions(collection);
  const load = async () => {
    const response = await githubApi(ctx.egress, {
      followRedirects: true,
      operation: link.kind === "issue" ? "github.issue.get" : "github.pull.get",
      path: `${repoPath(link)}/${collection}/${link.number}`,
    });
    // GitHub answers 404 for a missing object, and 410 for a deleted issue.
    if (response.status === 404 || response.status === 410) {
      return { ...options, value: null };
    }
    if (!response.ok) {
      throw new Error(
        `GitHub ${link.kind} lookup failed with HTTP ${response.status}`,
      );
    }
    return entry(schema.parse(response.body));
  };
  // The page read ran out of time for this card, so it shows its stale
  // entry, or no card yet, and does not wait for one more read.
  if (collection === "pulls" && ctx.prefetchOutcome === "out_of_time") {
    const stale = await ctx.cache
      .getOrLoad(key, () => Promise.reject(OUT_OF_TIME))
      .catch((error: unknown) => {
        if (error === OUT_OF_TIME) return undefined;
        throw error;
      });
    return schema.nullable().safeParse(stale).data ?? null;
  }
  const cached = schema
    .nullable()
    .safeParse(await ctx.cache.getOrLoad(key, load));
  if (cached.success) return cached.data;
  // An entry from before the cache kept object fields holds a card.
  return await ctx.cache.getOrLoad(key, load, { refresh: true });
}

/** Read the card of the object. Nothing for a missing or deleted one. */
async function readObject(
  ctx: ObjectLinkContext,
  link: GitHubObjectLink,
): Promise<ObjectAnnotation | null> {
  if (link.kind === "pull_request") {
    const pull = await readFields(
      ctx,
      link,
      githubPullRequestFieldsSchema,
      githubPullRequestEntry,
    );
    return (
      pull &&
      pullRequestCard(
        link,
        pull,
        await readCategories(ctx, htmlUrlLink(pull.html_url) ?? link),
      )
    );
  }
  const issue = await readFields(
    ctx,
    link,
    githubIssueFieldsSchema,
    (value) => ({ ...GITHUB_ISSUE_CACHE, value }),
  );
  if (!issue) return null;
  // GitHub opens a pull request at its issue URL too, such as a linked
  // `owner/repo#12`. Only the pulls API has its draft and merge state.
  return issue.pull_request === undefined
    ? issueCard(link, issue)
    : await readObject(ctx, { ...link, kind: "pull_request" });
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
  // The object cache is shared by every viewer, and webhooks refresh it.
  cacheCards: false,
  canView: canViewLink,
  filters: [{ host: "github.com", pathPattern: "/*/*/issues/*" }],
  objectTypes: ["task", "code_change"],
  readTool: (object) =>
    object.objectType === "code_change"
      ? "github_getPullRequest"
      : "github_getIssue",
  resolve: resolveLink,
  webPageFallback: true,
};

async function prefetchLinks(
  ctx: ObjectLinkContext,
  urls: URL[],
): Promise<Map<string, ObjectLinkPrefetchOutcome>> {
  // A page can link one pull request more than once, such as `/pull/12`
  // and `/pull/12#discussion_r1`. Each link gets the outcome.
  const hrefs = new Map<string, string[]>();
  const refs = urls.flatMap((url) => {
    const link = parseLink(url);
    if (link?.kind !== "pull_request") return [];
    const key = `${link.owner}/${link.name}#${link.number}`;
    const known = hrefs.get(key);
    if (known) {
      known.push(url.href);
      return [];
    }
    hrefs.set(key, [url.href]);
    return [
      { name: link.name, number: Number(link.number), owner: link.owner },
    ];
  });
  const outOfTime = await prefetchGitHubPullRequests(ctx, refs);
  return new Map(
    outOfTime.flatMap((ref) =>
      (hrefs.get(`${ref.owner}/${ref.name}#${ref.number}`) ?? []).map(
        (href) => [href, "out_of_time" as const] as const,
      ),
    ),
  );
}

/** GitHub pull request links, such as `https://github.com/owner/repo/pull/12`. */
export const githubPullRequestLinks: PluginObjectLinkDefinition = {
  cacheCards: false,
  canView: canViewLink,
  filters: [{ host: "github.com", pathPattern: "/*/*/pull/*" }],
  objectTypes: ["code_change"],
  // A page of pull request cards reads GitHub in one query.
  prefetch: prefetchLinks,
  readTool: () => "github_getPullRequest",
  resolve: resolveLink,
  webPageFallback: true,
};
