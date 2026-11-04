import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  accountLink,
  attendeeOutputSchema,
  attendeeResults,
  formatInterval,
  googleAttendeeSchema,
  googleApiError,
  googleApiRequest,
  requesterEmail,
  requireAllowedEmails,
  timeZoneSchema,
  type GoogleToolContext,
} from "./shared";

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const inputSchema = z
  .object({
    calendar: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email())
      .optional()
      .describe(
        "Email address of the person whose calendar to read. Omit to read your own calendar, which holds every event you organize.",
      ),
    time_min: z.iso
      .datetime({ offset: true })
      .describe("Start of the window, RFC 3339 with offset."),
    time_max: z.iso
      .datetime({ offset: true })
      .describe(
        "End of the window, RFC 3339 with offset. At most 31 days after time_min.",
      ),
    time_zone: timeZoneSchema,
    max_results: z.number().int().min(1).max(100).default(50),
  })
  .strict();

const eventSchema = z.object({
  attendees: z.array(attendeeOutputSchema).optional(),
  end: z.string(),
  event_id: z.string(),
  label: z.string(),
  location: z.string().optional(),
  organizer: z.string().optional(),
  organized_by_junior: z
    .boolean()
    .describe(
      "True when you organize the event, so you can change or cancel it with this event_id.",
    ),
  series_event_id: z
    .string()
    .optional()
    .describe(
      "Set when this is one occurrence of a repeating event. It is the id of the whole series.",
    ),
  start: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  video_call_url: z.string().optional(),
});

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("listCalendarEvents"),
  calendar: z.string(),
  events: z.array(eventSchema),
  time_zone: z.string(),
  truncated: z.boolean(),
  visible: z.boolean(),
});

const eventTimeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
});

const listResponseSchema = z.object({
  items: z
    .array(
      z.object({
        attendees: z.array(googleAttendeeSchema).optional(),
        end: eventTimeSchema,
        hangoutLink: z.string().optional(),
        htmlLink: z.string().optional(),
        id: z.string(),
        location: z.string().optional(),
        organizer: z.object({ email: z.string().optional() }).optional(),
        recurringEventId: z.string().optional(),
        start: eventTimeSchema,
        status: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

type EventTime = z.infer<typeof eventTimeSchema>;

/** Google's all-day `end.date` is exclusive; return the last day of the event. */
function lastAllDayDate(end: EventTime): string | undefined {
  if (!end.date) return undefined;
  const day = new Date(`${end.date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function eventLabel(
  start: EventTime,
  end: EventTime,
  timeZone: string,
): string {
  if (start.dateTime && end.dateTime) {
    return formatInterval(
      Date.parse(start.dateTime),
      Date.parse(end.dateTime),
      timeZone,
    );
  }
  const first = start.date ?? "unknown date";
  const last = lastAllDayDate(end);
  return last && last !== first
    ? `${first} to ${last}, all day`
    : `${first}, all day`;
}

/**
 * Read the events Junior's account can see on one person's calendar.
 *
 * Google sharing settings decide what Junior sees. A calendar shared as
 * free/busy only returns busy blocks without titles. Descriptions are never
 * returned, because they often hold links and notes meant only for attendees.
 */
export function createListCalendarEventsTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "List events on a colleague's Google Calendar or on your own calendar, as seen by your own Google account. Shows titles, times, locations, organizer, and attendee responses when the calendar's sharing settings allow it. Use it to find an event to change or cancel, check who accepted, or see what someone has coming up. Events without a title are busy blocks the owner did not share. Only calendars in the company's Google Workspace domains can be read. Calendar details can be private: share only what the requester needs, and avoid repeating them in public channels.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const timeZone = input.time_zone ?? (await ctx.users.resolveTimezone());
      const timeMinMs = Date.parse(input.time_min);
      const timeMaxMs = Date.parse(input.time_max);
      if (timeMaxMs <= timeMinMs) {
        throw new PluginToolInputError("time_max must be after time_min.");
      }
      if (timeMaxMs - timeMinMs > MAX_WINDOW_MS) {
        throw new PluginToolInputError("Read at most 31 days at a time.");
      }
      const calendar = input.calendar ?? ctx.accountEmail;
      requireAllowedEmails([calendar], ctx.allowedDomains);

      const response = await googleApiRequest(ctx, {
        operation: "google.calendar.events.list",
        path: `/calendar/v3/calendars/${calendar === ctx.accountEmail ? "primary" : encodeURIComponent(calendar)}/events`,
        query: {
          maxResults: String(input.max_results),
          orderBy: "startTime",
          singleEvents: "true",
          timeMax: new Date(timeMaxMs).toISOString(),
          timeMin: new Date(timeMinMs).toISOString(),
          timeZone,
        },
      });
      const result = {
        target: "listCalendarEvents" as const,
        calendar,
        time_zone: timeZone,
      };
      // Google returns 404 when Junior's account cannot see the calendar.
      if (response.status === 404) {
        return { ...result, events: [], truncated: false, visible: false };
      }
      if (response.status !== 200) {
        throw googleApiError("google.calendar.events.list", response);
      }

      const { items, nextPageToken } = listResponseSchema.parse(response.body);
      const requester = await requesterEmail(ctx);
      return {
        ...result,
        events: items
          .filter((event) => event.status !== "cancelled")
          .map((event) => ({
            end: event.end.dateTime ?? lastAllDayDate(event.end) ?? "",
            event_id: event.id,
            label: eventLabel(event.start, event.end, timeZone),
            start: event.start.dateTime ?? event.start.date ?? "",
            ...(event.summary ? { title: event.summary } : undefined),
            ...(event.location ? { location: event.location } : undefined),
            ...(event.organizer?.email
              ? { organizer: event.organizer.email }
              : undefined),
            organized_by_junior:
              event.organizer?.email?.toLowerCase() === ctx.accountEmail,
            ...(event.recurringEventId
              ? { series_event_id: event.recurringEventId }
              : undefined),
            ...(event.attendees
              ? { attendees: attendeeResults(event.attendees) }
              : undefined),
            ...(event.htmlLink
              ? { url: accountLink(event.htmlLink, requester) }
              : undefined),
            ...(event.hangoutLink
              ? { video_call_url: event.hangoutLink }
              : undefined),
          })),
        truncated: nextPageToken !== undefined,
        visible: true,
      };
    },
  });
}
