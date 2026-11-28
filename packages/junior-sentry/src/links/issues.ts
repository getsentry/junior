/**
 * Link cards for Sentry issues.
 *
 * The viewer's own Sentry account must open the issue first, so Sentry
 * decides access. Then Junior's org read token reads the card, which is
 * cached per issue for every viewer. The card shows the title, the
 * culprit, the state, who owns it, and events per hour for the last day.
 * It never shows event data, tags, or stack frames.
 *
 * A user feedback is an issue too. Its card shows the feedback's title and
 * message, the state, who owns it, and the project. It never shows who sent
 * the feedback.
 */
import {
  objectSummary,
  type ObjectAnnotation,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { sentryApi, sentryData } from "./api.js";
import { sentryRegionOrigin } from "./region.js";
import {
  parseSentryIssueLink,
  SENTRY_ISSUE_LINK_FILTERS,
  type SentryIssueLink,
} from "./urls.js";

// The entry holds only card fields: each live read checks the viewer's
// access with their own token, apart from it. So a live card can be five
// minutes old, and a page load shows the last good card after that.
const ISSUE_CACHE_TTL_MS = 300_000;

const issueSchema = z.object({
  assignedTo: z.object({ name: z.string() }).nullish(),
  count: z.union([z.string(), z.number()]).optional(),
  culprit: z.string().nullish(),
  id: z.string(),
  issueCategory: z.string().nullish(),
  lastSeen: z.string().nullish(),
  level: z.string().nullish(),
  // Feedback adds `message` and `summary`, a title without the
  // "User Feedback: " prefix.
  metadata: z
    .object({
      message: z.string().nullish(),
      summary: z.string().nullish(),
      value: z.string().nullish(),
    })
    .partial()
    .nullish(),
  priority: z.string().nullish(),
  project: z.object({ slug: z.string() }),
  shortId: z.string(),
  // `24h` holds hourly `[timestamp, count]` pairs, oldest first.
  stats: z
    .object({ "24h": z.array(z.tuple([z.number(), z.number()])) })
    .partial()
    .nullish(),
  status: z.string(),
  substatus: z.string().nullish(),
  title: z.string(),
  userCount: z.number().optional(),
});

type SentryIssue = z.infer<typeof issueSchema>;

// Sentry's UI calls an ignored issue archived.
const STATUS_LABELS: Record<string, string> = {
  ignored: "archived",
  resolved: "resolved",
  unresolved: "unresolved",
};

// Sentry's feedback UI calls an ignored feedback spam.
const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  ...STATUS_LABELS,
  ignored: "spam",
};

// Only substatuses that say something new about an unresolved issue.
const SUBSTATUS_LABELS: Record<string, string> = {
  escalating: "escalating",
  new: "new",
  regressed: "regressed",
};

function issuePath(link: SentryIssueLink) {
  return { organization_id_or_slug: link.org, issue_id: link.issueId };
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

// The facts schema takes 2 to 60 nonnegative points.
function hourlyTrend(issue: SentryIssue) {
  const points = (issue.stats?.["24h"] ?? []).map(([, count]) => count);
  if (points.length < 2 || points.some((n) => n < 0)) {
    return undefined;
  }
  return { label: "Events, last 24 hours", points: points.slice(-60) };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function countText(count: SentryIssue["count"], users?: number) {
  const events = count === undefined ? undefined : Number(count);
  const parts = [
    events !== undefined && Number.isFinite(events)
      ? `${events.toLocaleString("en-US")} ${events === 1 ? "event" : "events"}`
      : undefined,
    users !== undefined
      ? `${users.toLocaleString("en-US")} ${users === 1 ? "user" : "users"}`
      : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * Map a Sentry issue to a Ticket card. Unknown values are left out.
 *
 * A Sentry issue reuses the Ticket type so that the shared card contract
 * does not change. A native Sentry issue object type is a possible
 * follow-up. It would give the card its own label and icon, and typed facts
 * such as level, substatus, and event count in place of the Ticket fields.
 */
function sentryIssueCard(
  issue: SentryIssue,
  link: SentryIssueLink,
  url: URL,
): ObjectAnnotation {
  const labels = [
    text(issue.level),
    issue.substatus ? SUBSTATUS_LABELS[issue.substatus] : undefined,
  ].filter((label): label is string => label !== undefined);
  // The title usually repeats the error message, so the culprit comes first.
  const message = issue.metadata?.value?.trim();
  const summary = objectSummary(
    issue.culprit?.trim() ||
      (message && !issue.title.includes(message) ? message : ""),
  );
  const assignee = text(issue.assignedTo?.name);
  const lastSeen =
    issue.lastSeen && !Number.isNaN(Date.parse(issue.lastSeen))
      ? new Date(issue.lastSeen).toISOString()
      : undefined;
  return {
    kind: "object",
    objectType: "task",
    key: `${link.org}/${issue.id}`,
    label: issue.shortId.slice(0, 80),
    title: issue.title.trim().slice(0, 512) || issue.shortId,
    url: url.href,
    displayType: "Sentry issue",
    status: STATUS_LABELS[issue.status],
    description: countText(issue.count, issue.userCount),
    sourceUpdatedAt: lastSeen,
    facts: {
      type: "task",
      summary,
      assignees: assignee ? [assignee] : [],
      priority: issue.priority ? capitalize(issue.priority) : undefined,
      project: text(issue.project.slug),
      labels: labels.length ? labels : undefined,
      trend: hourlyTrend(issue),
    },
  };
}

/** Map a Sentry user feedback to a Ticket card. Unknown values are left out. */
function sentryFeedbackCard(
  issue: SentryIssue,
  link: SentryIssueLink,
  url: URL,
): ObjectAnnotation {
  const title =
    issue.metadata?.summary?.trim() ||
    issue.title.replace(/^User Feedback: /, "").trim();
  const message = issue.metadata?.message?.trim() ?? "";
  const assignee = text(issue.assignedTo?.name);
  return {
    kind: "object",
    objectType: "task",
    key: `${link.org}/${issue.id}`,
    label: issue.shortId.slice(0, 80),
    title: title.slice(0, 512) || issue.shortId,
    url: url.href,
    displayType: "User feedback",
    status: FEEDBACK_STATUS_LABELS[issue.status],
    facts: {
      type: "task",
      summary: message === title ? undefined : objectSummary(message),
      assignees: assignee ? [assignee] : [],
      project: text(issue.project.slug),
    },
  };
}

/**
 * Return whether the viewer's own Sentry account can open the issue. A
 * viewer who has not connected Sentry gets 401.
 */
async function viewerCanSeeIssue(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryIssueLink,
): Promise<boolean> {
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.issue.access",
  ).getOrganizationIssue({ path: issuePath(link) });
  return sentryData(result, [401, 403, 404], "issue access check") !== null;
}

/** Read an issue with Junior's own token. Nothing for a missing issue. */
async function readIssue(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryIssueLink,
): Promise<SentryIssue | null> {
  const result = await sentryApi(
    ctx.egress,
    origin,
    "sentry.issue.get",
  ).getOrganizationIssue({ path: issuePath(link) });
  // A token for another org gets 403. A merged-away or deleted issue is 404.
  const data = sentryData(result, [401, 403, 404], "issue read");
  const parsed = data === null ? undefined : issueSchema.safeParse(data);
  return parsed?.success ? parsed.data : null;
}

async function canViewSentryIssueLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  const link = parseSentryIssueLink(url);
  if (!link) return false;
  // A page load shows the stored card to anyone who can read the
  // Conversation, so it checks no viewer access.
  if (ctx.cacheOnly) return true;
  const origin = await sentryRegionOrigin(ctx, link.org);
  return origin ? viewerCanSeeIssue(ctx, origin, link) : false;
}

/** Read the issue through the cache. Nothing when Junior cannot read it. */
async function readCachedIssue(
  ctx: ObjectLinkContext,
  key: string,
  link: SentryIssueLink,
): Promise<SentryIssue | null> {
  const origin = await sentryRegionOrigin(ctx, link.org);
  if (!origin) return null;
  return await ctx.cache.getOrLoad(key, async () => ({
    staleIfError: true,
    value: await readIssue(ctx, origin, link),
    ttlMs: ISSUE_CACHE_TTL_MS,
  }));
}

async function resolveSentryIssueLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const link = parseSentryIssueLink(url);
  if (!link) return undefined;
  const key = `issue:${link.org}/${link.issueId.toUpperCase()}`;
  const issue = ctx.cacheOnly
    ? await ctx.cache.get<SentryIssue | null>(key, { stale: true })
    : await readCachedIssue(ctx, key, link);
  if (!issue) return undefined;
  return issue.issueCategory === "feedback"
    ? sentryFeedbackCard(issue, link, url)
    : sentryIssueCard(issue, link, url);
}

/** Sentry issue and feedback links, on sentry.io and on customer domains. */
export const sentryIssueLinks: PluginObjectLinkDefinition = {
  cacheOnlyReads: true,
  canView: canViewSentryIssueLink,
  filters: SENTRY_ISSUE_LINK_FILTERS,
  objectTypes: ["task"],
  resolve: resolveSentryIssueLink,
};
