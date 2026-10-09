import {
  PluginToolInputError,
  type PluginEgress,
  type User,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { emailDomain } from "../config";
import {
  GOOGLE_API_DOMAIN,
  GOOGLE_OPERATIONS,
  type GoogleOperation,
} from "../credentials";

/** Runtime capabilities the Calendar tools use. */
export interface GoogleToolContext {
  /** The Workspace account Junior acts as, in lowercase. */
  accountEmail: string;
  allowedDomains: string[];
  egress: PluginEgress;
  users: {
    resolveActor(): Promise<{ user?: User } | undefined>;
  };
}

export const emailListSchema = (max: number) =>
  z
    .array(z.string().trim().toLowerCase().pipe(z.email()))
    .max(max)
    .describe("Attendee email addresses.");

export const timeZoneSchema = z
  .string()
  .min(1)
  .refine(isTimeZone, "timeZone must be an IANA time zone")
  .describe(
    "IANA time zone used to read and show times, such as America/Los_Angeles.",
  );

/** True when the runtime knows this IANA time zone. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Reject people outside the domains Junior may look up or invite. */
export function requireAllowedEmails(
  emails: string[],
  allowedDomains: string[],
): void {
  const outside = emails.filter((email) => {
    const domain = emailDomain(email);
    return !domain || !allowedDomains.includes(domain);
  });
  if (outside.length > 0) {
    throw new PluginToolInputError(
      `Junior can only schedule with people at ${allowedDomains.join(", ")}. Not allowed: ${outside.join(", ")}`,
    );
  }
}

/** Return the requester's email in lowercase, when Junior knows it. */
export async function requesterEmail(
  ctx: GoogleToolContext,
): Promise<string | undefined> {
  return (await ctx.users.resolveActor())?.user?.email?.trim().toLowerCase();
}

/**
 * Add the requester's email when Junior knows it and it is in an allowed
 * domain. People rarely type their own address.
 */
export async function withRequester(
  ctx: GoogleToolContext,
  emails: string[],
): Promise<string[]> {
  const requester = await requesterEmail(ctx);
  const domain = requester ? emailDomain(requester) : undefined;
  const all =
    requester && domain && ctx.allowedDomains.includes(domain)
      ? [requester, ...emails]
      : emails;
  return [...new Set(all)];
}

const googleErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
});

/** Call one Google Calendar API operation through host-owned egress. */
export async function googleApiRequest(
  ctx: GoogleToolContext,
  input: {
    body?: unknown;
    operation: GoogleOperation;
    path: string;
    query?: Record<string, string>;
  },
): Promise<{ body: unknown; status: number }> {
  const url = new URL(`https://${GOOGLE_API_DOMAIN}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await ctx.egress.fetch({
    operation: input.operation,
    provider: "google",
    request: new Request(url, {
      method: GOOGLE_OPERATIONS[input.operation].method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  return { body, status: response.status };
}

/** Turn a failed Google response into a tool error. */
export function googleApiError(
  operation: GoogleOperation,
  response: { body: unknown; status: number },
): Error {
  const parsed = googleErrorSchema.safeParse(response.body);
  const detail = parsed.success ? parsed.data.error?.message : undefined;
  const message = `Google ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
  return response.status === 400
    ? new PluginToolInputError(message)
    : new Error(message);
}

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
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  return `${day}, ${time.format(startMs)} – ${time.format(endMs)}`;
}

/** Longest event Junior may create or move an event to. */
export const MAX_EVENT_MS = 8 * 60 * 60 * 1000;

/** Google attendee fields that tools read and return. */
export const googleAttendeeSchema = z
  .object({
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

/** Event fields that Junior reads back from its own calendar. */
export const ownEventSchema = z.object({
  attendees: z.array(googleAttendeeSchema).optional(),
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
});

export type OwnEvent = z.infer<typeof ownEventSchema>;

/** Shape one event on Junior's calendar for a tool result. */
export function ownEventResult(event: OwnEvent, timeZone: string) {
  return {
    attendees: attendeeResults(event.attendees),
    end: event.end.dateTime,
    eventId: event.id,
    label: formatInterval(
      Date.parse(event.start.dateTime),
      Date.parse(event.end.dateTime),
      timeZone,
    ),
    start: event.start.dateTime,
    ...(event.summary ? { title: event.summary } : undefined),
    ...(event.location ? { location: event.location } : undefined),
    ...(event.recurrence ? { repeats: true } : undefined),
    ...(event.recurringEventId
      ? { seriesEventId: event.recurringEventId }
      : undefined),
    ...(event.htmlLink ? { url: event.htmlLink } : undefined),
    ...(event.hangoutLink ? { videoCallUrl: event.hangoutLink } : undefined),
  };
}

/** Output fields shared by the tools that create or change Junior's events. */
export const ownEventOutputFields = {
  attendees: z.array(attendeeOutputSchema),
  end: z.string(),
  eventId: z.string(),
  label: z.string(),
  location: z.string().optional(),
  repeats: z
    .boolean()
    .optional()
    .describe("True when this event id is a whole repeating series."),
  seriesEventId: z
    .string()
    .optional()
    .describe(
      "Set when this is one occurrence of a repeating event. Use it as eventId to change or cancel the whole series.",
    ),
  start: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  videoCallUrl: z.string().optional(),
};

/** Event id or link input for tools that act on an event Junior organizes. */
export const ownEventIdSchema = z
  .string()
  .trim()
  .min(5)
  .max(2048)
  .describe(
    "Event id from a Calendar tool, or a Google Calendar event link. An occurrence of a repeating event has its own id; its seriesEventId is the whole series.",
  );

const EVENT_ID_PATTERN = /^[A-Za-z0-9_]{5,1024}$/;

/**
 * Return the event id from an id or a Google Calendar event link.
 *
 * A link's `eid` value is base64 for `<eventId> <calendar email>`.
 */
export function parseEventId(value: string): string {
  let eventId = value;
  if (/^https?:\/\//.test(value)) {
    const eid = URL.parse(value)?.searchParams.get("eid");
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
      `Junior does not know the requester's email, so it cannot check that they may ${action} this event.`,
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
      `Junior's calendar has no event ${eventId}. Junior can only ${action} events it organizes; ask the organizer instead.`,
    );
  }
  if (response.status !== 200) {
    throw googleApiError("google.calendar.event.get", response);
  }
  const event = ownEventSchema.parse(response.body);
  if (event.organizer?.self !== true) {
    throw new PluginToolInputError(
      `Junior does not organize this event, so it cannot ${action} it. Ask the organizer instead.`,
    );
  }
  if (
    !(event.attendees ?? []).some(
      (attendee) => attendee.email.toLowerCase() === requester,
    )
  ) {
    throw new PluginToolInputError(
      `Only people invited to this event can ask Junior to ${action} it.`,
    );
  }
  return { event, eventId, path, status: "active" };
}
