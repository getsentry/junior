import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
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
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
// Meetings this close count as back to back, so 25- and 50-minute meetings
// join the next one.
const BACK_TO_BACK_GAP_MS = 15 * 60_000;
const FOCUS_BLOCK_MS = 2 * 60 * 60_000;
const SHORT_FOCUS_BLOCK_MS = 60 * 60_000;
const OPTIONAL_WEIGHT = 0.5;

const inputSchema = z
  .object({
    attendees: emailListSchema(20)
      .min(1)
      .describe(
        "Work emails of the people who must attend. Resolve names with userLookup. The runtime adds the requester as required when it knows their email. To make the requester optional, put their email in optional_attendees.",
      ),
    optional_attendees: emailListSchema(20)
      .default([])
      .describe(
        'Work emails of people the requester calls optional or "if free". Their conflicts do not block a slot; slots where they are free come first. Put the requester here when their own events must not block a slot, such as events they call holds.',
      ),
    duration_minutes: z.number().int().min(15).max(480).default(30),
    time_min: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Start of the search window, RFC 3339 with offset. Defaults to now. For an exact requested time, search only that slot.",
      ),
    time_max: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "End of the search window, RFC 3339 with offset. Defaults to 7 days after time_min. At most 14 days after time_min.",
      ),
    time_zone: timeZoneSchema.describe(
      "IANA time zone for slot labels, such as America/Los_Angeles. Omit to use the requester's time zone. It is also the working-hours zone for anyone whose calendar time zone you cannot read.",
    ),
    workday_start: clockTimeSchema
      .default("09:00")
      .describe(
        "Earliest local start, 24-hour HH:MM, in each attendee's own calendar time zone.",
      ),
    workday_end: clockTimeSchema
      .default("17:00")
      .describe(
        "Latest local end, 24-hour HH:MM, in each attendee's own calendar time zone.",
      ),
    lunch_start: clockTimeSchema
      .default("11:30")
      .describe(
        "Start of the lunch window, 24-hour HH:MM, in each attendee's own calendar time zone.",
      ),
    lunch_end: clockTimeSchema
      .default("14:00")
      .describe("End of the lunch window, 24-hour HH:MM."),
    lunch_minutes: z
      .number()
      .int()
      .min(0)
      .max(180)
      .default(60)
      .describe(
        "Free time each attendee keeps for lunch inside the lunch window. Set 0 for a requested lunch meeting.",
      ),
    max_back_to_back_minutes: z
      .number()
      .int()
      .min(60)
      .max(600)
      .default(180)
      .describe(
        "Longest run of back-to-back meetings a slot may create for an attendee. Gaps under 15 minutes count as back to back.",
      ),
    weekdays: z
      .array(z.enum(WEEKDAYS))
      .min(1)
      .optional()
      .describe(
        "Only return slots on these days, in the time_zone of the slot labels. Omit to search every weekday.",
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3)
      .describe(
        "Maximum slots to return. Slots come best first: days on which attendees already have meetings, so days without meetings stay free; then most focus time kept (free blocks of 2 hours, or 1 hour on days without one); then slots that join existing meetings.",
      ),
  })
  .strict();

const slotSchema = z.object({
  end: z.string(),
  label: z.string().describe("The slot in the requester's time zone."),
  other_time_zone_labels: z
    .array(z.string())
    .optional()
    .describe("The slot in the other attendees' time zones."),
  optional_conflicts: z
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
      time_zone: z
        .string()
        .optional()
        .describe(
          "Time zone of the person's calendar. Missing when you cannot read it; their hours then use the requester's time zone.",
        ),
    }),
  ),
  slots: z.array(slotSchema),
  time_zone: z.string(),
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
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Length of a window on the clock of `timeZone`, so a daylight-saving change
 * inside it does not add or remove an hour.
 */
function wallClockMs(startMs: number, endMs: number, timeZone: string): number {
  const format = localFormat(timeZone);
  const start = localParts(startMs, format);
  const end = localParts(endMs, format);
  return (
    Date.parse(`${end.date}T00:00:00Z`) -
    Date.parse(`${start.date}T00:00:00Z`) +
    (end.minutes - start.minutes) * 60_000
  );
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

/** How a slot fits attendees' days. */
interface Cost {
  /** Attendees who already have a meeting that day. Higher is better. */
  meetingDays: number;
  /** Focus time the slot removes. Lower is better. */
  focusLostMs: number;
  /** New runs of meetings, each one more interruption. Lower is better. */
  runsAdded: number;
}

interface Candidate extends Interval {
  cost: Cost;
  date: string;
  optionalConflicts: string[];
}

function overlaps(busy: Interval, startMs: number, endMs: number): boolean {
  return busy.endMs > startMs && busy.startMs < endMs;
}

function byCost(a: Cost, b: Cost): number {
  return (
    b.meetingDays - a.meetingDays ||
    a.focusLostMs - b.focusLostMs ||
    a.runsAdded - b.runsAdded
  );
}

/** Slots without optional conflicts first, then days with more meetings. */
function byTier(a: Candidate, b: Candidate): number {
  return (
    Number(a.optionalConflicts.length > 0) -
      Number(b.optionalConflicts.length > 0) ||
    b.cost.meetingDays - a.cost.meetingDays
  );
}

/** Merge busy times that are back to back into runs of meetings. */
function meetingRuns(busy: Interval[]): Interval[] {
  const runs: Interval[] = [];
  for (const interval of [...busy].sort((a, b) => a.startMs - b.startMs)) {
    const last = runs.at(-1);
    if (last && interval.startMs - last.endMs < BACK_TO_BACK_GAP_MS) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      runs.push({ ...interval });
    }
  }
  return runs;
}

/** Free time between sorted runs inside `window`. */
function freeGaps(runs: Interval[], window: Interval): Interval[] {
  const gaps: Interval[] = [];
  let cursor = window.startMs;
  for (const run of runs) {
    if (!overlaps(run, window.startMs, window.endMs)) continue;
    if (run.startMs > cursor) {
      gaps.push({ endMs: run.startMs, startMs: cursor });
    }
    cursor = Math.max(cursor, run.endMs);
  }
  if (cursor < window.endMs) {
    gaps.push({ endMs: window.endMs, startMs: cursor });
  }
  return gaps;
}

function length(interval: Interval): number {
  return interval.endMs - interval.startMs;
}

/**
 * Pick the option that costs the least. Among equal options, pick the one
 * farthest from the options already chosen on that day, then the earliest.
 */
function bestOption(
  options: Candidate[],
  chosen: Candidate[],
): Candidate | undefined {
  let best: Candidate | undefined;
  let bestGap = -1;
  for (const option of options) {
    const gap = chosen.length
      ? Math.min(
          ...chosen.map((slot) => Math.abs(slot.startMs - option.startMs)),
        )
      : 0;
    const order = best ? byCost(option.cost, best.cost) : -1;
    if (order < 0 || (order === 0 && gap > bestGap)) {
      best = option;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Take one option from each day per round, so people get a real choice of
 * days. In each round, days with a cheaper option go first. Chosen options
 * never overlap.
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
    const round = [...days]
      .flatMap(([date, options]) => {
        const next = bestOption(options, chosen.get(date) ?? []);
        return next ? [{ date, next, options }] : [];
      })
      .sort((a, b) => byCost(a.next.cost, b.next.cost));
    for (const { date, next, options } of round) {
      if (result.length >= max) break;
      days.set(
        date,
        options.filter(
          (option) => !overlaps(next, option.startMs, option.endMs),
        ),
      );
      chosen.set(date, [...(chosen.get(date) ?? []), next]);
      result.push(next);
      progress = true;
    }
  }
  return result;
}

/**
 * Find slots when every required attendee is free, inside their working
 * hours in their own time zone, and rank them by how little they disturb
 * those days.
 *
 * Days on which more attendees already have a meeting come first, so days
 * without meetings stay free. A day without meetings is used only when busy
 * days have too few slots. The requester chose this over pure focus time.
 *
 * Then the rules follow Clockwise's public docs, not its code:
 * - Focus time is the free time in blocks of at least 2 hours, or 1 hour on
 *   a day without a 2-hour block. Slots that remove the least focus time,
 *   summed over attendees, come first. Optional attendees count half.
 * - Among equal slots, the one that adds the fewest new runs of meetings
 *   comes first, so a slot next to a meeting beats an isolated one.
 * - A slot must leave each attendee a free gap of `lunchMinutes` inside
 *   their lunch window, if they had one. Set `lunchMinutes` to 0 to allow
 *   lunch meetings.
 * - A slot must not make a run of back-to-back meetings longer than
 *   `maxBackToBackMinutes`. Gaps under 15 minutes count as back to back.
 *
 * Optional attendees who are busy or break these rules do not block a slot.
 * Slots without such conflicts come first. Inside each group of equal
 * conflicts and meeting days, options are spread across the days of
 * `timeZone`. Results come best first. With `weekdays`, only those
 * days of `timeZone` are searched.
 *
 * Exported for tests. Busy intervals come from Google free/busy only, so
 * Junior never sees event titles or details.
 */
export function findFreeSlots(input: {
  attendees: SlotAttendee[];
  durationMinutes: number;
  lunchEnd: string;
  lunchMinutes: number;
  lunchStart: string;
  maxBackToBackMinutes: number;
  maxResults: number;
  timeMaxMs: number;
  timeMinMs: number;
  timeZone: string;
  weekdays?: readonly string[];
  workdayEnd: string;
  workdayStart: string;
}): Array<Interval & { optionalConflicts: string[] }> {
  const durationMs = input.durationMinutes * 60_000;
  const stepMs = (input.durationMinutes < 30 ? 15 : 30) * 60_000;
  const dayStart = clockMinutes(input.workdayStart);
  const dayEnd = clockMinutes(input.workdayEnd);
  const lunchStart = clockMinutes(input.lunchStart);
  const lunchEnd = clockMinutes(input.lunchEnd);
  const lunchMs = input.lunchMinutes * 60_000;
  const maxRunMs = Math.max(input.maxBackToBackMinutes * 60_000, durationMs);
  const formats = new Map<string, Intl.DateTimeFormat>();
  const partsIn = (ms: number, timeZone: string) => {
    let format = formats.get(timeZone);
    if (!format) {
      format = localFormat(timeZone);
      formats.set(timeZone, format);
    }
    return localParts(ms, format);
  };
  const runsByEmail = new Map(
    input.attendees.map((attendee) => [
      attendee.email,
      meetingRuns(attendee.busy),
    ]),
  );
  /** The cost of the slot for one attendee, or undefined if they cannot take it. */
  const assess = (attendee: SlotAttendee, slot: Interval) => {
    const start = partsIn(slot.startMs, attendee.timeZone);
    const end = partsIn(slot.endMs, attendee.timeZone);
    if (
      start.weekday === "Sat" ||
      start.weekday === "Sun" ||
      start.date !== end.date ||
      start.minutes < dayStart ||
      end.minutes > dayEnd ||
      attendee.busy.some((busy) => overlaps(busy, slot.startMs, slot.endMs))
    ) {
      return undefined;
    }
    const before = runsByEmail.get(attendee.email) ?? [];
    const after = meetingRuns([...before, slot]);
    const run = after.find(
      (run) => run.startMs <= slot.startMs && run.endMs >= slot.endMs,
    );
    if (run && length(run) > maxRunMs) {
      return undefined;
    }
    // Daylight-saving changes happen at night, so working hours and lunch
    // keep the offset of the slot.
    const midnightMs = slot.startMs - start.minutes * 60_000;
    const at = (minutes: number) => midnightMs + minutes * 60_000;
    const lunch = { endMs: at(lunchEnd), startMs: at(lunchStart) };
    const hasLunch = (runs: Interval[]) =>
      freeGaps(runs, lunch).some((gap) => length(gap) >= lunchMs);
    if (lunchMs > 0 && hasLunch(before) && !hasLunch(after)) {
      return undefined;
    }
    const workday = { endMs: at(dayEnd), startMs: at(dayStart) };
    // Free/busy leaves out all-day events that do not block time, and one
    // that does covers the slot, so only timed meetings count here.
    const meetingDay = before.some((run) =>
      overlaps(run, workday.startMs, workday.endMs),
    );
    const blockMs = freeGaps(before, workday).some(
      (gap) => length(gap) >= FOCUS_BLOCK_MS,
    )
      ? FOCUS_BLOCK_MS
      : SHORT_FOCUS_BLOCK_MS;
    const focusMs = (runs: Interval[]) =>
      freeGaps(runs, workday)
        .filter((gap) => length(gap) >= blockMs)
        .reduce((total, gap) => total + length(gap), 0);
    const runsInDay = (runs: Interval[]) =>
      runs.filter((run) => overlaps(run, workday.startMs, workday.endMs))
        .length;
    return {
      focusLostMs: focusMs(before) - focusMs(after),
      meetingDays: Number(meetingDay),
      runsAdded: runsInDay(after) - runsInDay(before),
    };
  };
  const required = input.attendees.filter((attendee) => attendee.required);
  const optional = input.attendees.filter((attendee) => !attendee.required);
  const candidates: Candidate[] = [];

  for (
    let startMs = Math.ceil(input.timeMinMs / stepMs) * stepMs;
    startMs + durationMs <= input.timeMaxMs;
    startMs += stepMs
  ) {
    const slot = { endMs: startMs + durationMs, startMs };
    const local = partsIn(startMs, input.timeZone);
    if (input.weekdays && !input.weekdays.includes(local.weekday)) continue;
    const cost: Cost = { focusLostMs: 0, meetingDays: 0, runsAdded: 0 };
    const add = (part: Cost, weight: number) => {
      cost.focusLostMs += part.focusLostMs * weight;
      cost.meetingDays += part.meetingDays * weight;
      cost.runsAdded += part.runsAdded * weight;
    };
    const requiredCosts = required.map((attendee) => assess(attendee, slot));
    if (!requiredCosts.every((part) => part !== undefined)) continue;
    for (const part of requiredCosts) add(part, 1);
    const optionalConflicts: string[] = [];
    for (const attendee of optional) {
      const part = assess(attendee, slot);
      if (part) add(part, OPTIONAL_WEIGHT);
      else optionalConflicts.push(attendee.email);
    }
    candidates.push({ ...slot, cost, date: local.date, optionalConflicts });
  }

  // Fill places from the best tier first, so a lower tier only fills the
  // places that better tiers leave.
  const sorted = [...candidates].sort(byTier);
  const picked: Candidate[] = [];
  let first = 0;
  while (first < sorted.length && picked.length < input.maxResults) {
    let end = first + 1;
    while (end < sorted.length && byTier(sorted[first]!, sorted[end]!) === 0) {
      end += 1;
    }
    picked.push(
      ...spreadAcrossDays(
        sorted.slice(first, end),
        input.maxResults - picked.length,
      ),
    );
    first = end;
  }
  return picked
    .sort(
      (a, b) => byTier(a, b) || byCost(a.cost, b.cost) || a.startMs - b.startMs,
    )
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
export const findMeetingTimesTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Find meeting times when every required attendee is free and in working hours, using free/busy data from your own Google account. Returns open slots best first, never event details. Offer a short list in that order; if the requester lets you choose, take the first. Only people in the company's Google Workspace domains can be checked. People in `unavailable` were not checked: say so, and never treat them as free. If no slot is free, widen the window or shorten the meeting once, then offer the closest option.",
  inputSchema,
  outputSchema,
  async execute(input, _options, ctx: GoogleToolContext) {
    const timeZone = input.time_zone ?? (await ctx.users.resolveTimezone());
    const timeMinMs = Math.max(
      input.time_min ? Date.parse(input.time_min) : 0,
      Date.now(),
    );
    const timeMaxMs = input.time_max
      ? Date.parse(input.time_max)
      : timeMinMs + DEFAULT_WINDOW_MS;
    if (timeMaxMs <= timeMinMs) {
      throw new PluginToolInputError(
        "time_max must be after time_min and now.",
      );
    }
    if (wallClockMs(timeMinMs, timeMaxMs, timeZone) > MAX_WINDOW_MS) {
      throw new PluginToolInputError("Search at most 14 days at a time.");
    }
    if (clockMinutes(input.workday_end) <= clockMinutes(input.workday_start)) {
      throw new PluginToolInputError(
        "workday_end must be after workday_start.",
      );
    }
    if (
      input.lunch_minutes >
      clockMinutes(input.lunch_end) - clockMinutes(input.lunch_start)
    ) {
      throw new PluginToolInputError(
        "lunch_minutes must fit between lunch_start and lunch_end.",
      );
    }
    // An explicit optional entry for the requester wins over the automatic add.
    const optionalEmails = new Set(input.optional_attendees);
    const attendees = (await withRequester(ctx, input.attendees)).filter(
      (email) => input.attendees.includes(email) || !optionalEmails.has(email),
    );
    const required = new Set(attendees);
    const optionalAttendees = [...optionalEmails].filter(
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

    const checked: Array<{ email: string; time_zone?: string }> = [];
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
        ...(calendarZone ? { time_zone: calendarZone } : undefined),
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
          durationMinutes: input.duration_minutes,
          lunchEnd: input.lunch_end,
          lunchMinutes: input.lunch_minutes,
          lunchStart: input.lunch_start,
          maxBackToBackMinutes: input.max_back_to_back_minutes,
          maxResults: input.max_results,
          timeMaxMs,
          timeMinMs,
          timeZone,
          weekdays: input.weekdays,
          workdayEnd: input.workday_end,
          workdayStart: input.workday_start,
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
              other_time_zone_labels: otherTimeZones.map((zone) =>
                formatInterval(slot.startMs, slot.endMs, zone),
              ),
            }
          : undefined),
        ...(slot.optionalConflicts.length
          ? { optional_conflicts: slot.optionalConflicts }
          : undefined),
        start: new Date(slot.startMs).toISOString(),
      })),
      time_zone: timeZone,
      unavailable,
    };
  },
});
