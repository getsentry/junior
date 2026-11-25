/**
 * Link cards for Linear issues.
 *
 * The viewer's own Linear MCP login reads the issue with `get_issue`, so
 * Linear decides who sees the card. A viewer without a login or without
 * access sees no card. One cached read serves the access check and the
 * card.
 */
import type {
  ObjectAnnotation,
  ObjectLinkContext,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import { LINEAR_SUBJECT_KINDS } from "../inbox-subjects.js";
import {
  isLinearIssueIdentifier,
  linearIssueAnnotation,
  readLinearIssue,
  type LinearIssue,
} from "../issue-card.js";

// Long enough that the access check and the card share one read. A changed
// issue shows within the card cache time.
const ISSUE_READ_TTL_MS = 30_000;

interface IssueLink {
  identifier: string;
  workspace: string;
}

/**
 * Read the workspace and identifier of a Linear issue link, such as
 * `https://linear.app/acme/issue/ENG-123/fix-login`.
 */
function issueLink(url: URL): IssueLink | undefined {
  const [workspace, kind, identifier] = url.pathname.split("/").slice(1);
  if (!workspace || kind !== "issue" || !identifier) return undefined;
  if (!isLinearIssueIdentifier(identifier)) return undefined;
  return {
    identifier: identifier.toUpperCase(),
    workspace: workspace.toLowerCase(),
  };
}

function issueWorkspace(issue: LinearIssue): string | undefined {
  return URL.parse(issue.url)?.pathname.split("/")[1]?.toLowerCase();
}

async function fetchIssue(
  ctx: ObjectLinkContext,
  link: IssueLink,
): Promise<LinearIssue | null> {
  const result = await ctx.viewerMcp.callTool({
    name: "get_issue",
    arguments: { id: link.identifier },
  });
  // Linear answers an issue that the viewer cannot open with an error.
  if (result.status !== "success") return null;
  const issue = readLinearIssue(result).data;
  // An identifier is unique only in one workspace. The viewer's login can
  // be in another workspace that has an issue with the same identifier.
  if (!issue || issueWorkspace(issue) !== link.workspace) return null;
  // A team move gives the issue a new identifier, and Linear still finds it
  // by the old one. A result under another identifier must have the uuid
  // that ties the two together.
  if (issue.identifier !== link.identifier && !issue.uuid) return null;
  if (issue.uuid) await rekeyTickets(ctx, link, issue.uuid);
  return issue;
}

/**
 * Move Tickets that an older release saved by the identifier of the link to
 * Linear's uuid, from this viewer's own read. Only Tickets in the link's
 * workspace move: an identifier is unique only in one workspace. The card
 * does not need it, so a failure only logs.
 */
async function rekeyTickets(
  ctx: ObjectLinkContext,
  link: IssueLink,
  uuid: string,
): Promise<void> {
  try {
    await ctx.replaceSubjectId({
      kind: LINEAR_SUBJECT_KINDS.issue,
      from: link.identifier,
      to: uuid,
      urlPrefix: `https://linear.app/${link.workspace}/`,
    });
  } catch (error) {
    ctx.log.error("linear.issue_subject.rekey_failed", {}, error);
  }
}

/**
 * Read one issue as the viewer, through the plugin cache. Nothing when the
 * viewer has no Linear login or cannot open the issue.
 */
async function readViewerIssue(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<LinearIssue | undefined> {
  const link = issueLink(url);
  if (!link) return undefined;
  // Each viewer has their own entry: an issue holds only what they can see.
  const issue = await ctx.cache.getOrLoad(
    `issue:${ctx.viewer.id}:${link.workspace}:${link.identifier}`,
    async () => ({
      value: await fetchIssue(ctx, link),
      ttlMs: ISSUE_READ_TTL_MS,
    }),
  );
  return issue ?? undefined;
}

async function canViewLinearIssue(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  return !!(await readViewerIssue(ctx, url));
}

async function resolveLinearIssue(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const issue = await readViewerIssue(ctx, url);
  return issue ? linearIssueAnnotation(issue) : undefined;
}

/** Linear issue links, with or without a title slug, as task cards. */
export const linearIssueLinks: PluginObjectLinkDefinition = {
  filters: [
    { host: "linear.app", pathPattern: "/*/issue/*" },
    { host: "linear.app", pathPattern: "/*/issue/*/*" },
  ],
  canView: canViewLinearIssue,
  // The identifier, such as `ENG-123`, when the card cannot load.
  label: (url) => issueLink(url)?.identifier,
  objectTypes: ["task"],
  resolve: resolveLinearIssue,
};
