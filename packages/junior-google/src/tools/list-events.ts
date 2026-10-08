import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  formatInterval,
  googleApiError,
  googleApiRequest,
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
      .describe("Email address of the person whose calendar to read."),
    timeMin: z.iso
      .datetime({ offset: true })
      .describe("Start of the window, RFC 3339 with offset."),
    timeMax: z.iso
      .datetime({ offset: true })
      .describe(
        "End of the window, RFC 3339 with offset. At most 31 days after timeMin.",
      ),
    timeZone: timeZoneSchema,
    maxResults: z.number().int().min(1).max(100).default(50),
  })
  .strict();

const eventSchema = z.object({
  attendees: z.array(z.string()).optional(),
  end: z.string(),
  eventId: z.string(),
  label: z.string(),
  location: z.string().optional(),
  organizer: z.string().optional(),
  start: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  videoCallUrl: z.string().optional(),
});

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("listCalendarEvents"),
  calendar: z.string(),
  events: z.array(eventSchema),
  timeZone: z.string(),
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
        attendees: z.array(z.object({ email: z.string() })).optional(),
        end: eventTimeSchema,
        hangoutLink: z.string().optional(),
        htmlLink: z.string().optional(),
        id: z.string(),
        location: z.string().optional(),
        organizer: z.object({ email: z.string().optional() }).optional(),
        start: eventTimeSchema,
        status: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

function eventLabel(
  start: z.infer<typeof eventTimeSchema>,
  end: z.infer<typeof eventTimeSchema>,
  timeZone: string,
): string {
  if (start.dateTime && end.dateTime) {
    return formatInterval(
      Date.parse(start.dateTime),
      Date.parse(end.dateTime),
      timeZone,
    );
  }
  return `${start.date ?? "unknown date"}, all day`;
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
      "List events on a colleague's Google Calendar, as seen by Junior's own Google account. Shows titles, times, locations, organizer, and attendees when the calendar's sharing settings allow it. Events without a title are busy blocks the owner did not share. Only calendars in the company's Google Workspace domains can be read. Calendar details can be private: share only what the requester needs, and avoid repeating them in public channels.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const timeMinMs = Date.parse(input.timeMin);
      const timeMaxMs = Date.parse(input.timeMax);
      if (timeMaxMs <= timeMinMs) {
        throw new PluginToolInputError("timeMax must be after timeMin.");
      }
      if (timeMaxMs - timeMinMs > MAX_WINDOW_MS) {
        throw new PluginToolInputError("Read at most 31 days at a time.");
      }
      requireAllowedEmails([input.calendar], ctx.allowedDomains);

      const response = await googleApiRequest(ctx, {
        operation: "google.calendar.events.list",
        path: `/calendar/v3/calendars/${encodeURIComponent(input.calendar)}/events`,
        query: {
          maxResults: String(input.maxResults),
          orderBy: "startTime",
          singleEvents: "true",
          timeMax: new Date(timeMaxMs).toISOString(),
          timeMin: new Date(timeMinMs).toISOString(),
          timeZone: input.timeZone,
        },
      });
      const result = {
        target: "listCalendarEvents" as const,
        calendar: input.calendar,
        timeZone: input.timeZone,
      };
      // Google returns 404 when Junior's account cannot see the calendar.
      if (response.status === 404) {
        return { ...result, events: [], truncated: false, visible: false };
      }
      if (response.status !== 200) {
        throw googleApiError("google.calendar.events.list", response);
      }

      const { items, nextPageToken } = listResponseSchema.parse(response.body);
      return {
        ...result,
        events: items
          .filter((event) => event.status !== "cancelled")
          .map((event) => ({
            end: event.end.dateTime ?? event.end.date ?? "",
            eventId: event.id,
            label: eventLabel(event.start, event.end, input.timeZone),
            start: event.start.dateTime ?? event.start.date ?? "",
            ...(event.summary ? { title: event.summary } : undefined),
            ...(event.location ? { location: event.location } : undefined),
            ...(event.organizer?.email
              ? { organizer: event.organizer.email }
              : undefined),
            ...(event.attendees
              ? { attendees: event.attendees.map((person) => person.email) }
              : undefined),
            ...(event.htmlLink ? { url: event.htmlLink } : undefined),
            ...(event.hangoutLink
              ? { videoCallUrl: event.hangoutLink }
              : undefined),
          })),
        truncated: nextPageToken !== undefined,
        visible: true,
      };
    },
  });
}
