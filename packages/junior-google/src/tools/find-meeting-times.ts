import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  emailListSchema,
  formatInterval,
  googleApiError,
  googleApiRequest,
  requireAllowedEmails,
  timeZoneSchema,
  withRequester,
  type GoogleToolContext,
} from "./shared";

const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");

const inputSchema = z
  .object({
    attendees: emailListSchema(20)
      .min(1)
      .describe(
        "Email addresses of the people who must attend. Junior adds the requester automatically when it knows their email.",
      ),
    durationMinutes: z.number().int().min(15).max(480),
    timeMin: z.iso
      .datetime({ offset: true })
      .describe("Start of the search window, RFC 3339 with offset."),
    timeMax: z.iso
      .datetime({ offset: true })
      .describe(
        "End of the search window, RFC 3339 with offset. At most 14 days after timeMin.",
      ),
    timeZone: timeZoneSchema,
    workdayStart: clockTimeSchema
      .default("09:00")
      .describe("Earliest local start time in timeZone, 24-hour HH:MM."),
    workdayEnd: clockTimeSchema
      .default("17:00")
      .describe("Latest local end time in timeZone, 24-hour HH:MM."),
    maxResults: z.number().int().min(1).max(20).default(5),
  })
  .strict();

const slotSchema = z.object({
  end: z.string(),
  label: z.string(),
  start: z.string(),
});

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("findMeetingTimes"),
  checked: z.array(z.string()),
  slots: z.array(slotSchema),
  timeZone: z.string(),
  unavailable: z.array(z.object({ email: z.string(), reason: z.string() })),
});

const freeBusyResponseSchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z
        .array(z.object({ end: z.string(), start: z.string() }))
        .default([]),
      errors: z.array(z.object({ reason: z.string() })).optional(),
    }),
  ),
});

interface LocalParts {
  date: string;
  minutes: number;
  weekday: string;
}

function localParts(ms: number, format: Intl.DateTimeFormat): LocalParts {
  const parts = Object.fromEntries(
    format.formatToParts(ms).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday ?? "",
  };
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Find shared free slots on weekdays inside local working hours.
 *
 * Exported for tests. Busy intervals come from Google free/busy only, so
 * Junior never sees event titles or details.
 */
export function findFreeSlots(input: {
  busy: Array<{ endMs: number; startMs: number }>;
  durationMinutes: number;
  maxResults: number;
  timeMaxMs: number;
  timeMinMs: number;
  timeZone: string;
  workdayEnd: string;
  workdayStart: string;
}): Array<{ endMs: number; startMs: number }> {
  const durationMs = input.durationMinutes * 60_000;
  const stepMs = (input.durationMinutes < 30 ? 15 : 30) * 60_000;
  const format = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: input.timeZone,
    weekday: "short",
    year: "numeric",
  });
  const dayStart = clockMinutes(input.workdayStart);
  const dayEnd = clockMinutes(input.workdayEnd);
  const slots: Array<{ endMs: number; startMs: number }> = [];

  let startMs = Math.ceil(input.timeMinMs / stepMs) * stepMs;
  while (
    startMs + durationMs <= input.timeMaxMs &&
    slots.length < input.maxResults
  ) {
    const endMs = startMs + durationMs;
    const start = localParts(startMs, format);
    const end = localParts(endMs, format);
    const inWorkday =
      start.weekday !== "Sat" &&
      start.weekday !== "Sun" &&
      start.date === end.date &&
      start.minutes >= dayStart &&
      end.minutes <= dayEnd;
    const free = input.busy.every(
      (busy) => busy.endMs <= startMs || busy.startMs >= endMs,
    );
    if (inWorkday && free) {
      slots.push({ startMs, endMs });
      // Do not offer overlapping options.
      startMs = endMs;
    } else {
      startMs += stepMs;
    }
  }
  return slots;
}

/** Find times when everyone is free, using free/busy data only. */
export function createFindMeetingTimesTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Find meeting times when every attendee is free, using Google Calendar free/busy data from Junior's own Google account. Returns open slots only, never event details. Only people in the company's Google Workspace domains can be checked. People listed in `unavailable` were not checked; tell the user instead of treating them as free.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const timeMinMs = Math.max(Date.parse(input.timeMin), Date.now());
      const timeMaxMs = Date.parse(input.timeMax);
      if (timeMaxMs <= timeMinMs) {
        throw new PluginToolInputError(
          "timeMax must be after timeMin and now.",
        );
      }
      if (timeMaxMs - timeMinMs > MAX_WINDOW_MS) {
        throw new PluginToolInputError("Search at most 14 days at a time.");
      }
      if (clockMinutes(input.workdayEnd) <= clockMinutes(input.workdayStart)) {
        throw new PluginToolInputError(
          "workdayEnd must be after workdayStart.",
        );
      }
      const attendees = await withRequester(ctx, input.attendees);
      requireAllowedEmails(attendees, ctx.allowedDomains);

      const response = await googleApiRequest(ctx, {
        body: {
          items: attendees.map((id) => ({ id })),
          timeMax: new Date(timeMaxMs).toISOString(),
          timeMin: new Date(timeMinMs).toISOString(),
        },
        method: "POST",
        operation: "google.calendar.freebusy.query",
        path: "/calendar/v3/freeBusy",
      });
      if (response.status !== 200) {
        throw googleApiError("google.calendar.freebusy.query", response);
      }
      const { calendars } = freeBusyResponseSchema.parse(response.body);

      const checked: string[] = [];
      const unavailable: Array<{ email: string; reason: string }> = [];
      const busy: Array<{ endMs: number; startMs: number }> = [];
      for (const email of attendees) {
        const calendar = calendars[email];
        const error = calendar?.errors?.[0]?.reason;
        if (!calendar || error) {
          unavailable.push({ email, reason: error ?? "notFound" });
          continue;
        }
        checked.push(email);
        for (const interval of calendar.busy) {
          busy.push({
            endMs: Date.parse(interval.end),
            startMs: Date.parse(interval.start),
          });
        }
      }

      const slots =
        checked.length === 0
          ? []
          : findFreeSlots({
              busy,
              durationMinutes: input.durationMinutes,
              maxResults: input.maxResults,
              timeMaxMs,
              timeMinMs,
              timeZone: input.timeZone,
              workdayEnd: input.workdayEnd,
              workdayStart: input.workdayStart,
            });
      return {
        target: "findMeetingTimes" as const,
        checked,
        slots: slots.map((slot) => ({
          end: new Date(slot.endMs).toISOString(),
          label: formatInterval(slot.startMs, slot.endMs, input.timeZone),
          start: new Date(slot.startMs).toISOString(),
        })),
        timeZone: input.timeZone,
        unavailable,
      };
    },
  });
}
