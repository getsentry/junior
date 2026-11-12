/**
 * Link cards for Google Calendar events.
 *
 * Junior's own Google account reads the event from its own calendar, so the
 * card shows only when the viewer organizes, created, or is invited to the
 * event. Any unclear case gets no card.
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
  googleAttendeeSchema,
  isTimeZone,
} from "../tools/shared";

const EVENT_ID_PATTERN = /^[A-Za-z0-9_]{5,1024}$/;

const eventTimeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

const linkedEventSchema = z.object({
  attendees: z.array(googleAttendeeSchema).optional(),
  creator: z.object({ email: z.string().optional() }).optional(),
  end: eventTimeSchema,
  guestsCanSeeOtherGuests: z.boolean().optional(),
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
  const eid =
    url.searchParams.get("eid") ??
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

function eventWhen(event: LinkedEvent): string | undefined {
  const { start, end } = event;
  if (start.dateTime && end.dateTime) {
    const timeZone =
      start.timeZone && isTimeZone(start.timeZone) ? start.timeZone : "UTC";
    return formatInterval(
      Date.parse(start.dateTime),
      Date.parse(end.dateTime),
      timeZone,
    );
  }
  return start.date;
}

/** Return whether the viewer organizes, created, or is invited to it. */
function viewerIsOnEvent(event: LinkedEvent, viewer: string): boolean {
  return [
    event.organizer?.email,
    event.creator?.email,
    ...(event.attendees ?? []).map((attendee) => attendee.email),
  ].some((email) => email?.toLowerCase() === viewer);
}

async function resolveGoogleCalendarLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const config = readGoogleConfig();
  const eventId = config && parseEventLink(url, config.accountEmail);
  if (!eventId) return undefined;
  const response = await googleApiRequest(ctx, {
    operation: "google.calendar.event.get",
    path: `/calendar/v3/calendars/primary/events/${eventId}`,
  });
  // Google answers 404 for an event that is not on Junior's calendar, and
  // 410 for a deleted one.
  if ([403, 404, 410].includes(response.status)) return undefined;
  if (response.status !== 200) {
    throw googleApiError("google.calendar.event.get", response);
  }
  const parsed = linkedEventSchema.safeParse(response.body);
  if (!parsed.success || parsed.data.status === "cancelled") return undefined;
  const event = parsed.data;
  const viewer = ctx.viewer.email.toLowerCase();
  if (!viewerIsOnEvent(event, viewer)) return undefined;
  // Guests see the guest list only when the organizer allows it.
  const showGuests =
    event.guestsCanSeeOtherGuests !== false ||
    event.organizer?.email?.toLowerCase() === viewer;
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
      when: eventWhen(event),
      attendees: showGuests
        ? (event.attendees ?? [])
            .filter((attendee) => attendee.resource !== true)
            .slice(0, 5)
            .map((attendee) =>
              (attendee.displayName?.trim() || attendee.email).slice(0, 160),
            )
        : undefined,
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
  objectType: "calendar_event",
  resolve: resolveGoogleCalendarLink,
};
