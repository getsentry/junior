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
import { githubObjectFacts } from "./object-facts.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubApi, repoPath } from "./tool-support/github-api.js";

// The same time as the card cache, so a changed object shows within a minute.
const OBJECT_CACHE_TTL_MS = 60_000;

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

interface GitHubObjectLink {
  kind: "issue" | "pull_request";
  name: string;
  number: string;
  owner: string;
}

/** A card, a pull request at an issue URL, or a missing object. */
type ObjectRead = ObjectAnnotation | "pull_request" | null;

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

function objectCard(link: GitHubObjectLink, body: unknown): ObjectRead {
  if (link.kind === "issue") {
    const issue = issueSchema.parse(body);
    if (issue.pull_request !== undefined) return "pull_request";
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
  const pull = pullRequestSchema.parse(body);
  return githubObjectAnnotation({
    ...githubObjectFacts("code_change", body),
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

/** Read the object with the App. Nothing for a missing or deleted one. */
async function readObject(
  ctx: ObjectLinkContext,
  link: GitHubObjectLink,
): Promise<ObjectRead> {
  const collection = link.kind === "issue" ? "issues" : "pulls";
  return await ctx.cache.getOrLoad(
    `${collection}:${link.owner}/${link.name}#${link.number}`.toLowerCase(),
    async () => {
      const response = await githubApi(ctx.egress, {
        followRedirects: true,
        operation:
          link.kind === "issue" ? "github.issue.get" : "github.pull.get",
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
      return {
        value: objectCard(link, response.body),
        ttlMs: OBJECT_CACHE_TTL_MS,
      };
    },
  );
}

async function canViewLink(ctx: ObjectLinkContext, url: URL): Promise<boolean> {
  const link = parseLink(url);
  if (!link || !(await viewerCanSeeRepository(ctx, link))) return false;
  const card = await readObject(ctx, link);
  // GitHub opens a pull request at its issue URL too, such as a linked
  // `owner/repo#12`. It is not an issue, so it keeps the web page card.
  if (card === "pull_request") return false;
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
  const card = link ? await readObject(ctx, link) : null;
  return card && card !== "pull_request" ? card : undefined;
}

/** GitHub issue links, such as `https://github.com/owner/repo/issues/12`. */
export const githubIssueLinks: PluginObjectLinkDefinition = {
  canView: canViewLink,
  filters: [{ host: "github.com", pathPattern: "/*/*/issues/*" }],
  objectType: "task",
  readTool: () => "github_getIssue",
  resolve: resolveLink,
  webPageFallback: true,
};

/** GitHub pull request links, such as `https://github.com/owner/repo/pull/12`. */
export const githubPullRequestLinks: PluginObjectLinkDefinition = {
  canView: canViewLink,
  filters: [{ host: "github.com", pathPattern: "/*/*/pull/*" }],
  objectType: "code_change",
  readTool: () => "github_getPullRequest",
  resolve: resolveLink,
  webPageFallback: true,
};
