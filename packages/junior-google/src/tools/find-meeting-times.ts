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
  isTimeZone,
  requireAllowedEmails,
  timeZoneSchema,
  withRequester,
  type GoogleToolContext,
} from "./shared";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 14 * DAY_MS;
const DEFAULT_WINDOW_MS = 7 * DAY_MS;
const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");

const inputSchema = z
  .object({
    attendees: emailListSchema(20)
      .min(1)
      .describe(
        "Work emails of the people who must attend. Resolve people with userLookup, by Slack user ID when the conversation shows one. Junior adds the requester automatically when it knows their email.",
      ),
    optionalAttendees: emailListSchema(20)
      .default([])
      .describe(
        'Work emails of people the requester calls optional or "if free". Their conflicts do not block a slot; slots where they are free come first.',
      ),
    durationMinutes: z.number().int().min(15).max(480).default(30),
    timeMin: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Start of the search window, RFC 3339 with offset. Defaults to now. For an exact requested time, search only that slot.",
      ),
    timeMax: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "End of the search window, RFC 3339 with offset. Defaults to 7 days after timeMin. At most 14 days after timeMin.",
      ),
    timeZone: timeZoneSchema.describe(
      "IANA time zone for slot labels, such as America/Los_Angeles. Omit to use the requester's time zone. It is also the working-hours zone for anyone whose calendar time zone Junior cannot read.",
    ),
    workdayStart: clockTimeSchema
      .default("09:00")
      .describe(
        "Earliest local start, 24-hour HH:MM, in each attendee's own calendar time zone.",
      ),
    workdayEnd: clockTimeSchema
      .default("17:00")
      .describe(
        "Latest local end, 24-hour HH:MM, in each attendee's own calendar time zone.",
      ),
    maxResults: z.number().int().min(1).max(20).default(3),
  })
  .strict();

const slotSchema = z.object({
  end: z.string(),
  label: z.string().describe("The slot in the requester's time zone."),
  otherTimeZoneLabels: z
    .array(z.string())
    .optional()
    .describe("The slot in the other attendees' time zones."),
  optionalConflicts: z
    .array(z.string())
    .optional()
    .describe(
      "Optional attendees who are busy or outside their working hours at this time.",
    ),
  start: z.string(),
});

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("findMeetingTimes"),
  checked: z.array(
    z.object({
      email: z.string(),
      timeZone: z
        .string()
        .optional()
        .describe(
          "Time zone of the person's calendar. Missing when Junior cannot read it; their hours then use the requester's time zone.",
        ),
    }),
  ),
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

const calendarTimeZoneSchema = z.object({ timeZone: z.string().optional() });

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

function localFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    weekday: "short",
    year: "numeric",
  });
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

interface Interval {
  endMs: number;
  startMs: number;
}

/** One checked attendee, with busy times from Google free/busy. */
export interface SlotAttendee {
  busy: Interval[];
  email: string;
  required: boolean;
  /** IANA time zone used for this person's working hours. */
  timeZone: string;
}

interface Candidate extends Interval {
  date: string;
  optionalConflicts: string[];
}

function overlaps(busy: Interval, startMs: number, endMs: number): boolean {
  return busy.endMs > startMs && busy.startMs < endMs;
}

/** Pick the option farthest from the ones already chosen on that day. */
function farthestOption(
  options: Candidate[],
  chosen: Candidate[],
): Candidate | undefined {
  if (chosen.length === 0) return options[0];
  let best: Candidate | undefined;
  let bestGap = -1;
  for (const option of options) {
    const gap = Math.min(
      ...chosen.map((slot) => Math.abs(slot.startMs - option.startMs)),
    );
    if (gap > bestGap) {
      best = option;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Take options from each day in turn, so people get a real choice instead of
 * back-to-back slots on the first free morning.
 */
function spreadAcrossDays(candidates: Candidate[], max: number): Candidate[] {
  const days = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    days.set(candidate.date, [...(days.get(candidate.date) ?? []), candidate]);
  }
  const chosen = new Map<string, Candidate[]>();
  const result: Candidate[] = [];
  let progress = true;
  while (result.length < max && progress) {
    progress = false;
    for (const [date, options] of days) {
      if (result.length >= max) break;
      const picked = chosen.get(date) ?? [];
      const next = farthestOption(options, picked);
      if (!next) continue;
      options.splice(options.indexOf(next), 1);
      picked.push(next);
      chosen.set(date, picked);
      result.push(next);
      progress = true;
    }
  }
  return result;
}

/**
 * Find slots inside every required attendee's working hours, in their own
 * time zone, when they are all free.
 *
 * Optional attendees who are busy or outside their hours do not block a slot.
 * Slots without such conflicts come first. Options are spread across the days
 * of `timeZone` and across each day.
 *
 * Exported for tests. Busy intervals come from Google free/busy only, so
 * Junior never sees event titles or details.
 */
export function findFreeSlots(input: {
  attendees: SlotAttendee[];
  durationMinutes: number;
  maxResults: number;
  timeMaxMs: number;
  timeMinMs: number;
  timeZone: string;
  workdayEnd: string;
  workdayStart: string;
}): Array<Interval & { optionalConflicts: string[] }> {
  const durationMs = input.durationMinutes * 60_000;
  const stepMs = (input.durationMinutes < 30 ? 15 : 30) * 60_000;
  const dayStart = clockMinutes(input.workdayStart);
  const dayEnd = clockMinutes(input.workdayEnd);
  const formats = new Map<string, Intl.DateTimeFormat>();
  const partsIn = (ms: number, timeZone: string) => {
    let format = formats.get(timeZone);
    if (!format) {
      format = localFormat(timeZone);
      formats.set(timeZone, format);
    }
    return localParts(ms, format);
  };
  const available = (
    attendee: SlotAttendee,
    startMs: number,
    endMs: number,
  ) => {
    const start = partsIn(startMs, attendee.timeZone);
    const end = partsIn(endMs, attendee.timeZone);
    return (
      start.weekday !== "Sat" &&
      start.weekday !== "Sun" &&
      start.date === end.date &&
      start.minutes >= dayStart &&
      end.minutes <= dayEnd &&
      attendee.busy.every((busy) => !overlaps(busy, startMs, endMs))
    );
  };
  const required = input.attendees.filter((attendee) => attendee.required);
  const optional = input.attendees.filter((attendee) => !attendee.required);
  const candidates: Candidate[] = [];

  let startMs = Math.ceil(input.timeMinMs / stepMs) * stepMs;
  while (startMs + durationMs <= input.timeMaxMs) {
    const endMs = startMs + durationMs;
    if (required.every((attendee) => available(attendee, startMs, endMs))) {
      candidates.push({
        date: partsIn(startMs, input.timeZone).date,
        endMs,
        optionalConflicts: optional
          .filter((attendee) => !available(attendee, startMs, endMs))
          .map((attendee) => attendee.email),
        startMs,
      });
      // Do not offer overlapping options.
      startMs = endMs;
    } else {
      startMs += stepMs;
    }
  }

  const picked = spreadAcrossDays(
    candidates.filter((slot) => slot.optionalConflicts.length === 0),
    input.maxResults,
  );
  picked.push(
    ...spreadAcrossDays(
      candidates.filter((slot) => slot.optionalConflicts.length > 0),
      input.maxResults - picked.length,
    ),
  );
  return picked
    .sort((a, b) => a.startMs - b.startMs)
    .map(({ endMs, optionalConflicts, startMs }) => ({
      endMs,
      optionalConflicts,
      startMs,
    }));
}

/**
 * Read the time zone of one person's calendar.
 *
 * Google does not expose people's working hours, so the calendar time zone is
 * the closest signal. Returns undefined when Junior's account cannot see the
 * calendar.
 */
async function calendarTimeZone(
  ctx: GoogleToolContext,
  email: string,
): Promise<string | undefined> {
  const response = await googleApiRequest(ctx, {
    operation: "google.calendar.events.list",
    path: `/calendar/v3/calendars/${encodeURIComponent(email)}/events`,
    // No `timeZone` parameter: Google then answers with the calendar's own.
    query: { fields: "timeZone", maxResults: "1" },
  });
  if (response.status === 403 || response.status === 404) {
    return undefined;
  }
  if (response.status !== 200) {
    throw googleApiError("google.calendar.events.list", response);
  }
  const { timeZone } = calendarTimeZoneSchema.parse(response.body);
  return timeZone && isTimeZone(timeZone) ? timeZone : undefined;
}

/**
 * Find times when everyone is free and inside their working hours.
 *
 * Uses free/busy data and each calendar's time zone only.
 */
export function createFindMeetingTimesTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Find meeting times when every required attendee is free and inside working hours in their own calendar time zone, using Google Calendar free/busy data from Junior's own Google account. Returns open slots only, never event details. Slots are spread across days and times; offer them as a short list. Only people in the company's Google Workspace domains can be checked. People in `unavailable` were not checked: say so instead of treating them as free. If no slot is free, widen the window or shorten the meeting once, then offer the closest option.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const timeZone = input.timeZone ?? (await ctx.users.resolveTimezone());
      const timeMinMs = Math.max(
        input.timeMin ? Date.parse(input.timeMin) : 0,
        Date.now(),
      );
      const timeMaxMs = input.timeMax
        ? Date.parse(input.timeMax)
        : timeMinMs + DEFAULT_WINDOW_MS;
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
      const required = new Set(attendees);
      const optionalAttendees = [...new Set(input.optionalAttendees)].filter(
        (email) => !required.has(email),
      );
      const everyone = [...attendees, ...optionalAttendees];
      requireAllowedEmails(everyone, ctx.allowedDomains);

      const [response, ...timeZones] = await Promise.all([
        googleApiRequest(ctx, {
          body: {
            items: everyone.map((id) => ({ id })),
            timeMax: new Date(timeMaxMs).toISOString(),
            timeMin: new Date(timeMinMs).toISOString(),
          },
          operation: "google.calendar.freebusy.query",
          path: "/calendar/v3/freeBusy",
        }),
        ...everyone.map((email) => calendarTimeZone(ctx, email)),
      ]);
      if (response.status !== 200) {
        throw googleApiError("google.calendar.freebusy.query", response);
      }
      const { calendars } = freeBusyResponseSchema.parse(response.body);

      const checked: Array<{ email: string; timeZone?: string }> = [];
      const unavailable: Array<{ email: string; reason: string }> = [];
      const slotAttendees: SlotAttendee[] = [];
      everyone.forEach((email, index) => {
        const calendar = calendars[email];
        const error = calendar?.errors?.[0]?.reason;
        if (!calendar || error) {
          unavailable.push({ email, reason: error ?? "notFound" });
          return;
        }
        const calendarZone = timeZones[index];
        checked.push({
          email,
          ...(calendarZone ? { timeZone: calendarZone } : undefined),
        });
        slotAttendees.push({
          busy: calendar.busy.map((interval) => ({
            endMs: Date.parse(interval.end),
            startMs: Date.parse(interval.start),
          })),
          email,
          required: required.has(email),
          timeZone: calendarZone ?? timeZone,
        });
      });

      const slots = !slotAttendees.some((attendee) => attendee.required)
        ? []
        : findFreeSlots({
            attendees: slotAttendees,
            durationMinutes: input.durationMinutes,
            maxResults: input.maxResults,
            timeMaxMs,
            timeMinMs,
            timeZone,
            workdayEnd: input.workdayEnd,
            workdayStart: input.workdayStart,
          });
      const otherTimeZones = [
        ...new Set(slotAttendees.map((attendee) => attendee.timeZone)),
      ].filter((zone) => zone !== timeZone);
      return {
        target: "findMeetingTimes" as const,
        checked,
        slots: slots.map((slot) => ({
          end: new Date(slot.endMs).toISOString(),
          label: formatInterval(slot.startMs, slot.endMs, timeZone),
          ...(otherTimeZones.length
            ? {
                otherTimeZoneLabels: otherTimeZones.map((zone) =>
                  formatInterval(slot.startMs, slot.endMs, zone),
                ),
              }
            : undefined),
          ...(slot.optionalConflicts.length
            ? { optionalConflicts: slot.optionalConflicts }
            : undefined),
          start: new Date(slot.startMs).toISOString(),
        })),
        timeZone,
        unavailable,
      };
    },
  });
}
