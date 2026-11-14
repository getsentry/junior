/**
 * Link cards for one Sentry event, opened by project and event id.
 *
 * The viewer's own Sentry account reads the event, so Sentry decides who
 * may see it. The result is cached per viewer and event for a minute:
 * `canView` reads the event, and `resolve` draws the card from the same
 * entry. Junior's org read token only finds the org's region host. The
 * card shows the title, level, project, release, environment, and time,
 * never the event's data or tags beyond those.
 */
import {
  objectSummary,
  type ObjectAnnotation,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { sentryApi, sentryData } from "./api.js";
import {
  parseSentryEventLink,
  SENTRY_EVENT_LINK_FILTERS,
  type SentryEventLink,
} from "./event-urls.js";
import { sentryRegionOrigin } from "./region.js";

// The same time as the card cache.
const EVENT_CACHE_TTL_MS = 60_000;
// Sentry refuses an event that the token may not read, or a bad id.
const REFUSED = [400, 401, 403, 404];

/** What an event card shows, read with the viewer's own token. */
interface SentryEvent {
  title: string;
  culprit?: string | undefined;
  level?: string | undefined;
  release?: string | undefined;
  environment?: string | undefined;
  occurredAt?: string | undefined;
}

const eventSchema = z.object({
  title: z.string(),
  culprit: z.string().nullish(),
  dateCreated: z.string().nullish(),
  tags: z
    .array(z.object({ key: z.string(), value: z.string().nullish() }))
    .nullish(),
  release: z.object({ version: z.string() }).partial().nullish(),
});

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

/** Keep only the fields the card shows. */
function sentryEvent(data: z.infer<typeof eventSchema>): SentryEvent {
  const tag = (key: string) =>
    text(data.tags?.find((entry) => entry.key === key)?.value);
  const time = data.dateCreated ? Date.parse(data.dateCreated) : NaN;
  return {
    title: data.title.trim().slice(0, 512) || "(no title)",
    culprit: text(data.culprit),
    level: tag("level"),
    release: text(data.release?.version) ?? tag("release"),
    environment: tag("environment"),
    occurredAt: Number.isNaN(time) ? undefined : new Date(time).toISOString(),
  };
}

/** Read the event with the viewer's token. Nothing when Sentry refuses. */
async function readEvent(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryEventLink,
): Promise<SentryEvent | null> {
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.event.get",
  ).getProjectEvent({
    path: {
      organization_id_or_slug: link.org,
      project_id_or_slug: link.project,
      event_id: link.eventId,
    },
  });
  const data = sentryData(result, REFUSED, "event read");
  const parsed = data === null ? undefined : eventSchema.safeParse(data);
  return parsed?.success ? sentryEvent(parsed.data) : null;
}

/** Read the event for this viewer, cached per viewer and event. */
async function viewerEvent(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<{ link: SentryEventLink; event: SentryEvent } | null> {
  const link = parseSentryEventLink(url);
  if (!link) return null;
  const event = await ctx.cache.getOrLoad(
    `event:${ctx.viewer.id}:${link.org}/${link.project}:${link.eventId}`,
    async () => {
      const origin = await sentryRegionOrigin(ctx, link.org);
      const value = origin ? await readEvent(ctx, origin, link) : null;
      return { value, ttlMs: EVENT_CACHE_TTL_MS };
    },
  );
  return event && { link, event };
}

async function canViewSentryEventLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  return (await viewerEvent(ctx, url)) !== null;
}

async function resolveSentryEventLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const read = await viewerEvent(ctx, url);
  if (!read) return undefined;
  const { link, event } = read;
  return {
    kind: "object",
    objectType: "event",
    key: `event:${link.org}/${link.project}:${link.eventId}`,
    label: link.eventId.slice(0, 8),
    title: event.title,
    url: url.href.length <= 2048 ? url.href : null,
    displayType: "Sentry event",
    facts: {
      type: "event",
      summary: event.culprit ? objectSummary(event.culprit) : undefined,
      level: event.level,
      project: link.project,
      release: event.release,
      environment: event.environment,
      occurredAt: event.occurredAt,
    },
  };
}

/** Sentry project event links, on sentry.io and customer domains. */
export const sentryEventLinks: PluginObjectLinkDefinition = {
  canView: canViewSentryEventLink,
  filters: SENTRY_EVENT_LINK_FILTERS,
  objectType: "event",
  resolve: resolveSentryEventLink,
};
