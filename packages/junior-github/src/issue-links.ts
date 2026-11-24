/**
 * Link cards for GitHub issues and pull requests, such as a pasted
 * `https://github.com/getsentry/junior/pull/12`. They show the same card as
 * an issue or pull request that a GitHub tool read.
 *
 * The viewer's linked GitHub account must see the repository first. Then
 * the App reads the object, cached per object for every viewer. A viewer
 * without access gets the public web page card of the link, which shows
 * only what GitHub shows anyone signed out.
 */
import type {
  ObjectAnnotation,
  ObjectLinkContext,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubObjectAnnotation } from "./annotations.js";
import {
  GITHUB_OBJECT_CACHE,
  githubIssueFieldsSchema,
  githubObjectCacheKey,
  githubPullRequestFieldsSchema,
  type GitHubIssueFields,
  type GitHubPullRequestFields,
} from "./object-cache.js";
import { githubObjectFacts } from "./object-facts.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubApi, repoPath } from "./tool-support/github-api.js";

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO_PATTERN = /^[\w.-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9]\d{0,9}$/;

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

function pullRequestCard(
  link: GitHubObjectLink,
  pull: GitHubPullRequestFields,
): ObjectAnnotation {
  return githubObjectAnnotation({
    ...githubObjectFacts("code_change", pull),
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

/**
 * Read the object fields through the cache, or with the App. Nothing for a
 * missing or deleted object.
 */
async function readFields<T>(
  ctx: ObjectLinkContext,
  link: GitHubObjectLink,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const collection = link.kind === "issue" ? "issues" : "pulls";
  const key = githubObjectCacheKey(
    collection,
    `${link.owner}/${link.name}`,
    link.number,
  );
  const load = async () => {
    const response = await githubApi(ctx.egress, {
      followRedirects: true,
      operation: link.kind === "issue" ? "github.issue.get" : "github.pull.get",
      path: `${repoPath(link)}/${collection}/${link.number}`,
    });
    // GitHub answers 404 for a missing object, and 410 for a deleted issue.
    if (response.status === 404 || response.status === 410) {
      return { ...GITHUB_OBJECT_CACHE, value: null };
    }
    if (!response.ok) {
      throw new Error(
        `GitHub ${link.kind} lookup failed with HTTP ${response.status}`,
      );
    }
    return { ...GITHUB_OBJECT_CACHE, value: schema.parse(response.body) };
  };
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
    const pull = await readFields(ctx, link, githubPullRequestFieldsSchema);
    return pull && pullRequestCard(link, pull);
  }
  const issue = await readFields(ctx, link, githubIssueFieldsSchema);
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

/** GitHub pull request links, such as `https://github.com/owner/repo/pull/12`. */
export const githubPullRequestLinks: PluginObjectLinkDefinition = {
  cacheCards: false,
  canView: canViewLink,
  filters: [{ host: "github.com", pathPattern: "/*/*/pull/*" }],
  objectTypes: ["code_change"],
  readTool: () => "github_getPullRequest",
  resolve: resolveLink,
  webPageFallback: true,
};
