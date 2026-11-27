import {
  PluginToolInputError,
  type AnnotatedObject,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain } from "../config";
import { GOOGLE_SUBJECT_KINDS } from "../inbox-subjects";
import {
  googleApiError,
  googleApiRequest,
  requesterEmail,
  type GoogleToolContext,
} from "../google-api";

/** Format one interval for people, in the requested time zone. */
export function formatInterval(
  startMs: number,
  endMs: number,
  timeZone: string,
): string {
  const day = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone,
    weekday: "short",
  }).format(startMs);
  const time = (timeZoneName?: "short") =>
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      timeZone,
      timeZoneName,
    });
  return `${day}, ${time().format(startMs)} – ${time("short").format(endMs)}`;
}

/** Longest event Junior may create or move an event to. */
export const MAX_EVENT_MS = 8 * 60 * 60 * 1000;

/** Google attendee fields that tools read and return. */
export const googleAttendeeSchema = z
  .object({
    displayName: z.string().optional(),
    email: z.string(),
    optional: z.boolean().optional(),
    resource: z.boolean().optional(),
    responseStatus: z.string().optional(),
  })
  .loose();

/** One attendee in a tool result. */
export const attendeeOutputSchema = z.object({
  email: z.string(),
  optional: z.boolean().optional(),
  response: z
    .enum(["accepted", "declined", "tentative", "needsAction"])
    .optional(),
});

const RESPONSES = new Set(["accepted", "declined", "tentative", "needsAction"]);

/** Shape Google attendees for a tool result. Room resources are left out. */
export function attendeeResults(
  attendees: Array<z.infer<typeof googleAttendeeSchema>> | undefined,
): Array<z.infer<typeof attendeeOutputSchema>> {
  return (attendees ?? [])
    .filter((attendee) => attendee.resource !== true)
    .map((attendee) => ({
      email: attendee.email.toLowerCase(),
      ...(attendee.optional ? { optional: true } : undefined),
      ...(attendee.responseStatus && RESPONSES.has(attendee.responseStatus)
        ? {
            response: attendee.responseStatus as
              | "accepted"
              | "declined"
              | "tentative"
              | "needsAction",
          }
        : undefined),
    }));
}

// Personal Google accounts have no Workspace domain to choose.
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const ACCOUNT_CHOOSER_URL = "https://accounts.google.com/AccountChooser";

/**
 * Make a Google Calendar event link open in the viewer's Workspace account.
 *
 * Google opens a plain event link in the browser's default account, which is
 * often a personal one. AccountChooser picks the signed-in account of the
 * Workspace domain, then continues to the event. Everyone in a Slack thread
 * sees the same link, so the domain comes from Junior's own account, not the
 * requester. `authuser`, `authdomain`, `login_hint`, `hd` on the event link,
 * and `/u/<email>/` do not work for every viewer.
 *
 * Returns the link unchanged for a consumer domain, a link that is not an
 * event link, or a link that already goes through AccountChooser.
 */
export function accountChooserLink(url: string, accountEmail: string): string {
  const domain = emailDomain(accountEmail);
  if (
    !domain ||
    CONSUMER_DOMAINS.has(domain) ||
    !URL.parse(url)?.searchParams.has("eid")
  ) {
    return url;
  }
  const chooser = new URL(ACCOUNT_CHOOSER_URL);
  chooser.searchParams.set("hd", domain);
  chooser.searchParams.set("continue", url);
  return chooser.toString();
}

/** Event fields that Junior reads back from its own calendar. */
export const ownEventSchema = z.object({
  attendees: z.array(googleAttendeeSchema).optional(),
  description: z.string().optional(),
  end: z.object({ dateTime: z.string() }),
  hangoutLink: z.string().optional(),
  htmlLink: z.string().optional(),
  id: z.string(),
  location: z.string().optional(),
  organizer: z.object({ self: z.boolean().optional() }).optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  start: z.object({ dateTime: z.string() }),
  summary: z.string().optional(),
  updated: z.string().optional(),
});

export type OwnEvent = z.infer<typeof ownEventSchema>;

/**
 * Shape one event on Junior's calendar for a tool result.
 *
 * Core saves the Calendar event annotation and shows its card with the next
 * reply. The event id is the key, so a change replaces the saved card.
 */
export function ownEventResult(
  event: OwnEvent,
  timeZone: string,
  accountEmail: string,
  action: AnnotatedObject["action"],
) {
  const url =
    event.htmlLink && accountChooserLink(event.htmlLink, accountEmail);
  const when = formatInterval(
    Date.parse(event.start.dateTime),
    Date.parse(event.end.dateTime),
    timeZone,
  );
  const annotation: AnnotatedObject = {
    action,
    kind: "object",
    key: event.id,
    subject: { id: event.id, kind: GOOGLE_SUBJECT_KINDS.calendarEvent },
    objectType: "calendar_event",
    // People can edit the event in Calendar. Shorten long values so a
    // completed change never fails on the annotation schema.
    title: (event.summary?.trim() || "Untitled event").slice(0, 512),
    url: url || null,
  };
  return {
    objectAnnotations: [annotation],
    attendees: attendeeResults(event.attendees),
    end: event.end.dateTime,
    event_id: event.id,
    label: when,
    start: event.start.dateTime,
    ...(event.summary ? { title: event.summary } : undefined),
    ...(event.location ? { location: event.location } : undefined),
    ...(event.recurrence ? { repeats: true } : undefined),
    ...(event.recurringEventId
      ? { series_event_id: event.recurringEventId }
      : undefined),
    ...(url ? { url } : undefined),
    ...(event.hangoutLink ? { video_call_url: event.hangoutLink } : undefined),
  };
}

/** Output fields shared by the tools that create or change Junior's events. */
export const ownEventOutputFields = {
  attendees: z.array(attendeeOutputSchema),
  end: z.string(),
  event_id: z.string(),
  label: z.string(),
  location: z.string().optional(),
  repeats: z
    .boolean()
    .optional()
    .describe("True when this event id is a whole repeating series."),
  series_event_id: z
    .string()
    .optional()
    .describe(
      "Set when this is one occurrence of a repeating event. Use it as event_id to change or cancel the whole series.",
    ),
  start: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  video_call_url: z.string().optional(),
};

/** Event id or link input for tools that act on an event Junior organizes. */
export const ownEventIdSchema = z
  .string()
  .trim()
  .min(5)
  .max(2048)
  .describe(
    "Event id from a Calendar tool, or a Google Calendar event link. An occurrence of a repeating event has its own id; its series_event_id is the whole series.",
  );

const EVENT_ID_PATTERN = /^[A-Za-z0-9_]{5,1024}$/;

/**
 * Return the event id from an id or a Google Calendar event link.
 *
 * A link's `eid` value is base64 for `<eventId> <calendar email>`. An
 * AccountChooser link holds the event link in `continue`.
 */
export function parseEventId(value: string): string {
  let eventId = value;
  if (value.startsWith("https://") || value.startsWith("http://")) {
    const link = URL.parse(value);
    const target = link?.searchParams.get("continue");
    const eid = (target ? URL.parse(target) : link)?.searchParams.get("eid");
    eventId = eid
      ? (Buffer.from(eid, "base64").toString("utf8").split(" ")[0] ?? "")
      : "";
  }
  if (!EVENT_ID_PATTERN.test(eventId)) {
    throw new PluginToolInputError(
      "Use an event id from a Calendar tool or a Google Calendar event link.",
    );
  }
  return eventId;
}

const cancelledEventSchema = z.object({ status: z.literal("cancelled") });

/** Result of reading an event that Junior organizes. */
export type OwnEventRead =
  | { event: OwnEvent; eventId: string; path: string; status: "active" }
  | { eventId: string; path: string; status: "cancelled" };

/**
 * Read an event that Junior organizes, for a requester who is invited to it.
 *
 * Only invited people may change or cancel an event. This keeps one requester
 * from moving or cancelling a meeting that Junior set up for others.
 *
 * A deleted event on Junior's calendar comes back as `cancelled`. Google
 * returns it as HTTP 410, or as a stub with only `id` and `status`, so it has
 * no organizer or attendees to check. Callers must not change it.
 */
export async function readOwnEventForRequester(
  ctx: GoogleToolContext,
  eventIdOrLink: string,
  action: "change" | "cancel",
): Promise<OwnEventRead> {
  const eventId = parseEventId(eventIdOrLink);
  const requester = await requesterEmail(ctx);
  if (!requester) {
    throw new PluginToolInputError(
      `The requester's email is unknown, so the tool cannot check that they may ${action} this event. No change to the call can fix this.`,
    );
  }
  const path = `/calendar/v3/calendars/primary/events/${eventId}`;
  const response = await googleApiRequest(ctx, {
    operation: "google.calendar.event.get",
    path,
  });
  if (
    response.status === 410 ||
    (response.status === 200 &&
      cancelledEventSchema.safeParse(response.body).success)
  ) {
    return { eventId, path, status: "cancelled" };
  }
  if (response.status === 404) {
    throw new PluginToolInputError(
      `Your calendar has no event ${eventId}. You can only ${action} events you organize; ask the organizer instead.`,
    );
  }
  if (response.status !== 200) {
    throw googleApiError("google.calendar.event.get", response);
  }
  const event = ownEventSchema.parse(response.body);
  if (event.organizer?.self !== true) {
    throw new PluginToolInputError(
      `You do not organize this event, so you cannot ${action} it. Ask the organizer instead.`,
    );
  }
  if (
    !(event.attendees ?? []).some(
      (attendee) => attendee.email.toLowerCase() === requester,
    )
  ) {
    throw new PluginToolInputError(
      `Only people invited to this event can ask you to ${action} it. No change to the call can fix this.`,
    );
  }
  return { event, eventId, path, status: "active" };
}
