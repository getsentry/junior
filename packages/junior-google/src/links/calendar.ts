/**
 * Link cards for Google Calendar events.
 *
 * Junior's own Google account reads the event from its own calendar, so the
 * card shows only when the viewer organizes, created, or is invited to the
 * event. Any unclear case gets no card. The card shows the title, the time,
 * and the start of the description, never the guests.
 */
import type {
  ObjectAnnotation,
  ObjectLinkContext,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { readGoogleConfig } from "../config";
import {
  formatInterval,
  googleApiError,
  googleApiRequest,
  isTimeZone,
} from "../tools/shared";
import { htmlSummary } from "./summary";

const EVENT_ID_PATTERN = /^[A-Za-z0-9_]{5,1024}$/;

const eventTimeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

const linkedEventSchema = z.object({
  // Google leaves out `email` for some guests.
  attendees: z.array(z.object({ email: z.string().optional() })).optional(),
  creator: z.object({ email: z.string().optional() }).optional(),
  description: z.string().optional(),
  end: eventTimeSchema,
  id: z.string(),
  organizer: z.object({ email: z.string().optional() }).optional(),
  start: eventTimeSchema,
  status: z.string().optional(),
  summary: z.string().optional(),
  updated: z.string().optional(),
});

type LinkedEvent = z.infer<typeof linkedEventSchema>;

/**
 * Return the event id when the link points to an event on the calendar of
 * `calendarEmail`. The `eid` value is base64 for `<eventId> <calendar>`.
 */
function parseEventLink(url: URL, calendarEmail: string): string | undefined {
  // The query parser reads a base64 `+` as a space. Put it back.
  const eid =
    url.searchParams.get("eid")?.replaceAll(" ", "+") ??
    (url.pathname.includes("/eventedit/")
      ? url.pathname.split("/").at(-1)
      : undefined);
  if (!eid) return undefined;
  const [eventId, calendar] = Buffer.from(eid, "base64")
    .toString("utf8")
    .split(" ");
  return eventId &&
    EVENT_ID_PATTERN.test(eventId) &&
    calendar?.toLowerCase() === calendarEmail
    ? eventId
    : undefined;
}

/**
 * Event time in the event's own time zone. Junior does not know the
 * viewer's time zone here. An all-day event shows its first date.
 */
function eventWhen({ start, end }: LinkedEvent): string | undefined {
  if (start.dateTime && end.dateTime) {
    // `timeZone` is optional. Then the offset in `dateTime` gives the
    // event's clock time.
    const offset = /[+-]\d{2}:\d{2}$/.exec(start.dateTime)?.[0];
    const timeZone =
      [start.timeZone, offset].find((zone) => zone && isTimeZone(zone)) ??
      "UTC";
    return formatInterval(
      Date.parse(start.dateTime),
      Date.parse(end.dateTime),
      timeZone,
    );
  }
  if (!start.date) return undefined;
  // A date has no time zone. Format it in UTC so the day does not shift.
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  }).format(Date.parse(start.date));
}

/** Return whether the viewer organizes, created, or is invited to it. */
function viewerIsOnEvent(event: LinkedEvent, viewer: string): boolean {
  return [
    event.organizer?.email,
    event.creator?.email,
    ...(event.attendees ?? []).map((attendee) => attendee.email),
  ].some((email) => email?.toLowerCase() === viewer);
}

// Long enough that the access check and the card share one Calendar read.
const EVENT_READ_TTL_MS = 10_000;

/**
 * Read the linked event from Junior's calendar. Nothing for an event on
 * another calendar, or a deleted or cancelled one.
 */
async function readLinkedEvent(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<LinkedEvent | null> {
  const config = readGoogleConfig();
  const eventId = config && parseEventLink(url, config.accountEmail);
  if (!eventId) return null;
  return await ctx.cache.getOrLoad(`calendar-event:${eventId}`, async () => ({
    value: await fetchLinkedEvent(ctx, eventId),
    ttlMs: EVENT_READ_TTL_MS,
  }));
}

async function fetchLinkedEvent(
  ctx: ObjectLinkContext,
  eventId: string,
): Promise<LinkedEvent | null> {
  const response = await googleApiRequest(ctx, {
    operation: "google.calendar.event.get",
    path: `/calendar/v3/calendars/primary/events/${eventId}`,
  });
  // Google answers 404 for an event that is not on Junior's calendar, and
  // 410 for a deleted one.
  if ([403, 404, 410].includes(response.status)) return null;
  if (response.status !== 200) {
    throw googleApiError("google.calendar.event.get", response);
  }
  const parsed = linkedEventSchema.safeParse(response.body);
  return parsed.success && parsed.data.status !== "cancelled"
    ? parsed.data
    : null;
}

async function canViewGoogleCalendarLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  const event = await readLinkedEvent(ctx, url);
  return !!event && viewerIsOnEvent(event, ctx.viewer.email.toLowerCase());
}

async function resolveGoogleCalendarLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const event = await readLinkedEvent(ctx, url);
  if (!event) return undefined;
  const title = event.summary?.trim() || "Untitled event";
  return {
    kind: "object",
    objectType: "calendar_event",
    key: event.id,
    label: title.slice(0, 80),
    title: title.slice(0, 512),
    url: url.href,
    sourceUpdatedAt: event.updated,
    facts: {
      type: "calendar_event",
      summary: htmlSummary(event.description),
      when: eventWhen(event),
    },
  };
}

/** Google Calendar event links that resolve to Calendar event cards. */
export const googleCalendarLinks: PluginObjectLinkDefinition = {
  filters: [
    { host: "calendar.google.com", path: "/calendar/event" },
    { host: "www.google.com", path: "/calendar/event" },
    { host: "calendar.google.com", pathPattern: "/calendar/r/eventedit/*" },
    { host: "calendar.google.com", pathPattern: "/calendar/u/*/r/eventedit/*" },
  ],
  canView: canViewGoogleCalendarLink,
  objectType: "calendar_event",
  resolve: resolveGoogleCalendarLink,
};
