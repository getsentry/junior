import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  emailListSchema,
  googleApiError,
  googleApiRequest,
  isTimeZone,
  requireAllowedEmails,
  timeZoneSchema,
  withRequester,
  type GoogleToolContext,
} from "../google-api";
import {
  clockMinutes,
  findFreeSlots,
  wallClockMs,
  type SlotAttendee,
} from "../calendar/free-slots";
import { formatInterval } from "../calendar/events";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 14 * DAY_MS;
const DEFAULT_WINDOW_MS = 7 * DAY_MS;
const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;

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
    for (const [index, email] of everyone.entries()) {
      const calendar = calendars[email];
      const error = calendar?.errors?.[0]?.reason;
      if (!calendar || error) {
        unavailable.push({ email, reason: error ?? "notFound" });
        continue;
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
    }

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
