/**
 * Link cards for Sentry issues.
 *
 * The viewer's own Sentry account must open the issue first, so Sentry
 * decides access. Then Junior's org read token reads the card, which is
 * cached per issue for every viewer. The card shows the title, the
 * culprit, the state, and who owns it. It never shows event data, tags, or
 * stack frames.
 */
import {
  objectSummary,
  type ObjectAnnotation,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { sentryRegionOrigin } from "./region.js";
import {
  parseSentryIssueLink,
  SENTRY_ISSUE_LINK_FILTERS,
  type SentryIssueLink,
} from "./urls.js";

// The same time as the card cache, so a changed issue shows within a minute.
const ISSUE_CACHE_TTL_MS = 60_000;

const issueSchema = z.object({
  assignedTo: z.object({ name: z.string() }).nullish(),
  count: z.union([z.string(), z.number()]).optional(),
  culprit: z.string().nullish(),
  id: z.string(),
  lastSeen: z.string().nullish(),
  level: z.string().nullish(),
  metadata: z.object({ value: z.string().nullish() }).partial().nullish(),
  priority: z.string().nullish(),
  project: z.object({ slug: z.string() }),
  shortId: z.string(),
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

// Only substatuses that say something new about an unresolved issue.
const SUBSTATUS_LABELS: Record<string, string> = {
  escalating: "escalating",
  new: "new",
  regressed: "regressed",
};

function issueApiUrl(origin: string, link: SentryIssueLink): string {
  return `${origin}/api/0/organizations/${encodeURIComponent(link.org)}/issues/${encodeURIComponent(link.issueId)}/`;
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
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
    },
  };
}

/**
 * Return whether the viewer's own Sentry account can open the issue. A
 * viewer who has not connected Sentry gets 401. This stays apart from the
 * card read, so it can move to the link type's access check.
 */
async function viewerCanSeeIssue(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryIssueLink,
): Promise<boolean> {
  const response = await ctx.viewerEgress.fetch({
    operation: "sentry.issue.access",
    provider: "sentry",
    request: new Request(issueApiUrl(origin, link)),
  });
  // Drain the body so the connection is free. Only the status counts.
  await response.arrayBuffer();
  if (response.ok) return true;
  if ([401, 403, 404].includes(response.status)) return false;
  throw new Error(
    `Sentry issue access check failed with HTTP ${response.status}`,
  );
}

/** Read an issue with Junior's own token. Nothing for a missing issue. */
async function readIssue(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryIssueLink,
): Promise<SentryIssue | null> {
  const response = await ctx.egress.fetch({
    operation: "sentry.issue.get",
    provider: "sentry",
    request: new Request(issueApiUrl(origin, link)),
  });
  // A token for another org gets 403. A merged-away or deleted issue is 404.
  if ([401, 403, 404].includes(response.status)) return null;
  if (!response.ok) {
    throw new Error(`Sentry issue read failed with HTTP ${response.status}`);
  }
  const parsed = issueSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

async function resolveSentryIssueLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const link = parseSentryIssueLink(url);
  if (!link) return undefined;
  const origin = await sentryRegionOrigin(ctx, link.org);
  if (!origin || !(await viewerCanSeeIssue(ctx, origin, link))) {
    return undefined;
  }
  const issue = await ctx.cache.getOrLoad(
    `issue:${link.org}/${link.issueId.toUpperCase()}`,
    async () => ({
      value: await readIssue(ctx, origin, link),
      ttlMs: ISSUE_CACHE_TTL_MS,
    }),
  );
  return issue ? sentryIssueCard(issue, link, url) : undefined;
}

/** Sentry issue links, on sentry.io and on customer domains. */
export const sentryIssueLinks: PluginObjectLinkDefinition = {
  filters: SENTRY_ISSUE_LINK_FILTERS,
  objectType: "task",
  resolve: resolveSentryIssueLink,
};
