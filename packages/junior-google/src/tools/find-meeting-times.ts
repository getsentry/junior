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
    optionalAttendees: emailListSchema(20)
      .default([])
      .describe(
        "Email addresses of people who are nice to have. Their conflicts do not block a slot; slots where they are free come first.",
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
      .describe(
        "Earliest local start time in timeZone, 24-hour HH:MM. When attendees work in other time zones, narrow the window to hours that are inside everyone's working day.",
      ),
    workdayEnd: clockTimeSchema
      .default("17:00")
      .describe("Latest local end time in timeZone, 24-hour HH:MM."),
    maxResults: z.number().int().min(1).max(20).default(5),
  })
  .strict();

const slotSchema = z.object({
  end: z.string(),
  label: z.string(),
  optionalBusy: z
    .array(z.string())
    .optional()
    .describe("Optional attendees who are busy at this time."),
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

interface Interval {
  endMs: number;
  startMs: number;
}

interface Candidate extends Interval {
  date: string;
  optionalBusy: string[];
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
 * Find shared free slots on weekdays inside local working hours.
 *
 * Required attendees must be free. Slots where optional attendees are also
 * free come first. Options are spread across days and across each day.
 *
 * Exported for tests. Busy intervals come from Google free/busy only, so
 * Junior never sees event titles or details.
 */
export function findFreeSlots(input: {
  busy: Interval[];
  durationMinutes: number;
  maxResults: number;
  optionalBusy?: Array<Interval & { email: string }>;
  timeMaxMs: number;
  timeMinMs: number;
  timeZone: string;
  workdayEnd: string;
  workdayStart: string;
}): Array<Interval & { optionalBusy: string[] }> {
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
  const candidates: Candidate[] = [];

  let startMs = Math.ceil(input.timeMinMs / stepMs) * stepMs;
  while (startMs + durationMs <= input.timeMaxMs) {
    const endMs = startMs + durationMs;
    const start = localParts(startMs, format);
    const end = localParts(endMs, format);
    const inWorkday =
      start.weekday !== "Sat" &&
      start.weekday !== "Sun" &&
      start.date === end.date &&
      start.minutes >= dayStart &&
      end.minutes <= dayEnd;
    const free = input.busy.every((busy) => !overlaps(busy, startMs, endMs));
    if (inWorkday && free) {
      const optionalBusy = [
        ...new Set(
          (input.optionalBusy ?? [])
            .filter((busy) => overlaps(busy, startMs, endMs))
            .map((busy) => busy.email),
        ),
      ];
      candidates.push({ date: start.date, endMs, optionalBusy, startMs });
      // Do not offer overlapping options.
      startMs = endMs;
    } else {
      startMs += stepMs;
    }
  }

  const picked = spreadAcrossDays(
    candidates.filter((slot) => slot.optionalBusy.length === 0),
    input.maxResults,
  );
  picked.push(
    ...spreadAcrossDays(
      candidates.filter((slot) => slot.optionalBusy.length > 0),
      input.maxResults - picked.length,
    ),
  );
  return picked
    .sort((a, b) => a.startMs - b.startMs)
    .map(({ endMs, optionalBusy, startMs }) => ({
      endMs,
      optionalBusy,
      startMs,
    }));
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
      "Find meeting times when every required attendee is free, using Google Calendar free/busy data from Junior's own Google account. Returns open slots only, never event details. Slots are spread across days and times so the requester gets a real choice. Only people in the company's Google Workspace domains can be checked. People listed in `unavailable` were not checked; tell the user instead of treating them as free.",
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
      const required = new Set(attendees);
      const optionalAttendees = [...new Set(input.optionalAttendees)].filter(
        (email) => !required.has(email),
      );
      const everyone = [...attendees, ...optionalAttendees];
      requireAllowedEmails(everyone, ctx.allowedDomains);

      const response = await googleApiRequest(ctx, {
        body: {
          items: everyone.map((id) => ({ id })),
          timeMax: new Date(timeMaxMs).toISOString(),
          timeMin: new Date(timeMinMs).toISOString(),
        },
        operation: "google.calendar.freebusy.query",
        path: "/calendar/v3/freeBusy",
      });
      if (response.status !== 200) {
        throw googleApiError("google.calendar.freebusy.query", response);
      }
      const { calendars } = freeBusyResponseSchema.parse(response.body);

      const checked: string[] = [];
      const unavailable: Array<{ email: string; reason: string }> = [];
      const busy: Interval[] = [];
      const optionalBusy: Array<Interval & { email: string }> = [];
      for (const email of everyone) {
        const calendar = calendars[email];
        const error = calendar?.errors?.[0]?.reason;
        if (!calendar || error) {
          unavailable.push({ email, reason: error ?? "notFound" });
          continue;
        }
        checked.push(email);
        for (const interval of calendar.busy) {
          const parsed = {
            endMs: Date.parse(interval.end),
            startMs: Date.parse(interval.start),
          };
          if (required.has(email)) {
            busy.push(parsed);
          } else {
            optionalBusy.push({ ...parsed, email });
          }
        }
      }

      const slots = !checked.some((email) => required.has(email))
        ? []
        : findFreeSlots({
            busy,
            durationMinutes: input.durationMinutes,
            maxResults: input.maxResults,
            optionalBusy,
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
          ...(slot.optionalBusy.length
            ? { optionalBusy: slot.optionalBusy }
            : undefined),
          start: new Date(slot.startMs).toISOString(),
        })),
        timeZone: input.timeZone,
        unavailable,
      };
    },
  });
}
