import { bindPluginTools } from "@sentry/junior-testing/plugin-tool";
import {
  annotatedObjectSchema,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src/index";
import { recurrenceRule } from "../src/calendar/recurrence";
import { findFreeSlots, type SlotAttendee } from "../src/calendar/free-slots";
import { accountChooserLink, parseEventId } from "../src/calendar/events";
import { stubGoogleEnv } from "./fixture";

const REQUESTER = "alice@example.com";

function calendarTools(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const tools = bindPluginTools(googlePlugin().hooks!.tools!(), {
    egress: { fetch },
    users: {
      resolveActor: async () => ({
        user: { email: REQUESTER, id: "user-1", identities: [] },
      }),
      resolveTimezone: async () => "America/Los_Angeles",
    },
  } as never);
  return { fetch, tools };
}

const LA = "America/Los_Angeles";

// Defaults of findMeetingTimes.
const SLOT_RULES = {
  lunchEnd: "14:00",
  lunchMinutes: 60,
  lunchStart: "11:30",
  maxBackToBackMinutes: 180,
};
const LONDON = "Europe/London";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Tuesday 2026-10-13 at `time` in London (UTC+1). */
function london(time: string): number {
  return Date.parse(`2026-10-13T${time}:00+01:00`);
}

function busyAt(...ranges: Array<[string, string]>) {
  return ranges.map(([start, end]) => ({
    endMs: london(end),
    startMs: london(start),
  }));
}

/** `findFreeSlots` with the same working hours for every attendee. */
function slotsFor(
  input: Omit<Parameters<typeof findFreeSlots>[0], "attendees"> & {
    attendees: Array<Omit<SlotAttendee, "workingHours">>;
    workdayEnd?: string;
    workdayStart?: string;
  },
) {
  const { workdayEnd = "17:00", workdayStart = "09:00", ...rest } = input;
  return findFreeSlots({
    ...rest,
    attendees: input.attendees.map((attendee) => ({
      ...attendee,
      workingHours: { workdayEnd, workdayStart },
    })),
  });
}

function starts(slots: Array<{ startMs: number }>): string[] {
  return slots.map((slot) => new Date(slot.startMs).toISOString());
}

describe("findFreeSlots", () => {
  it("spreads non-overlapping weekday slots across days inside local working hours", () => {
    // Friday 2026-10-09 through Monday 2026-10-12, Los Angeles (UTC-7).
    const slots = slotsFor({
      ...SLOT_RULES,
      attendees: [
        {
          // Busy Friday 09:00-12:00 local.
          busy: [
            {
              startMs: Date.parse("2026-10-09T16:00:00Z"),
              endMs: Date.parse("2026-10-09T19:00:00Z"),
            },
          ],
          email: REQUESTER,
          required: true,
          timeZone: LA,
        },
      ],
      durationMinutes: 60,
      maxResults: 4,
      timeMaxMs: Date.parse("2026-10-13T00:00:00Z"),
      timeMinMs: Date.parse("2026-10-09T15:00:00Z"),
      timeZone: LA,
      workdayEnd: "14:00",
    });

    expect(starts(slots)).toEqual([
      // Friday has meetings, so its one slot comes first: 13:00 local. 12:00
      // would make a 4-hour run of meetings, and 12:30 would leave no lunch
      // break. Then skip the weekend.
      "2026-10-09T20:00:00.000Z",
      // Monday has no meetings, so it only fills the other places: 09:00,
      // 11:00, and 13:00 local each keep two hours or more of focus time.
      "2026-10-12T16:00:00.000Z",
      "2026-10-12T18:00:00.000Z",
      "2026-10-12T20:00:00.000Z",
    ]);
  });

  it("puts a slot next to existing meetings ahead of an isolated one or an empty day", () => {
    const slots = slotsFor({
      ...SLOT_RULES,
      // Meetings Tuesday 11:00-12:00 and 14:00-14:50. Monday is empty.
      attendees: [
        {
          busy: busyAt(["11:00", "12:00"], ["14:00", "14:50"]),
          email: REQUESTER,
          required: true,
          timeZone: LONDON,
        },
      ],
      durationMinutes: 30,
      maxResults: 3,
      timeMaxMs: london("23:00"),
      timeMinMs: london("00:00") - DAY_MS,
      timeZone: LONDON,
    });

    // Monday 09:00 keeps the most focus time, but Monday has no meetings.
    // On Tuesday, every slot breaks one 2-hour block. 10:30, 12:00, and
    // 13:30 join a meeting; 09:00 would add one more interruption.
    expect(starts(slots)).toEqual([
      "2026-10-13T09:30:00.000Z",
      "2026-10-13T11:00:00.000Z",
      "2026-10-13T12:30:00.000Z",
    ]);
  });

  it("uses a day without meetings when no busy day has a slot", () => {
    const slots = slotsFor({
      ...SLOT_RULES,
      // Tuesday is full except 12:00-13:00, its only lunch break. Monday is
      // empty.
      attendees: [
        {
          busy: busyAt(["09:00", "12:00"], ["13:00", "17:00"]),
          email: REQUESTER,
          required: true,
          timeZone: LONDON,
        },
      ],
      durationMinutes: 30,
      maxResults: 3,
      timeMaxMs: london("23:00"),
      timeMinMs: london("00:00") - DAY_MS,
      timeZone: LONDON,
    });

    expect(starts(slots)[0]).toBe("2026-10-12T08:00:00.000Z");
    expect(starts(slots).every((start) => start.startsWith("2026-10-12"))).toBe(
      true,
    );
  });

  it("puts a slot that keeps a 2-hour block ahead of one that splits it", () => {
    const slots = slotsFor({
      ...SLOT_RULES,
      attendees: [
        {
          busy: busyAt(["10:00", "11:00"], ["13:00", "14:00"]),
          email: REQUESTER,
          required: true,
          timeZone: LONDON,
        },
      ],
      durationMinutes: 30,
      lunchMinutes: 0,
      maxResults: 2,
      timeMaxMs: london("23:00"),
      timeMinMs: london("00:00"),
      timeZone: LONDON,
      workdayEnd: "14:00",
    });

    // 11:00 is next to a meeting too, but it splits the 11:00-13:00 block.
    expect(starts(slots)).toEqual([
      "2026-10-13T08:30:00.000Z",
      "2026-10-13T08:00:00.000Z",
    ]);
  });

  it("moves lunch inside the lunch window", () => {
    const slots = slotsFor({
      ...SLOT_RULES,
      attendees: [
        {
          busy: busyAt(["11:30", "12:00"]),
          email: REQUESTER,
          required: true,
          timeZone: LONDON,
        },
      ],
      durationMinutes: 60,
      maxResults: 3,
      timeMaxMs: london("13:30"),
      timeMinMs: london("12:00"),
      timeZone: LONDON,
    });

    // 12:00 leaves 13:00-14:00 for lunch. 12:30 leaves two 30-minute gaps.
    expect(starts(slots)).toEqual(["2026-10-13T11:00:00.000Z"]);
  });

  it("skips slots that take the last lunch break, unless lunch is off", () => {
    const rules = {
      ...SLOT_RULES,
      attendees: [
        {
          busy: busyAt(["11:30", "12:30"], ["13:30", "14:00"]),
          email: REQUESTER,
          required: true,
          timeZone: LONDON,
        },
      ],
      durationMinutes: 30,
      maxResults: 3,
      timeMaxMs: london("13:30"),
      timeMinMs: london("12:30"),
      timeZone: LONDON,
    };

    expect(slotsFor(rules)).toEqual([]);
    expect(starts(slotsFor({ ...rules, lunchMinutes: 0 }))).toEqual([
      "2026-10-13T11:30:00.000Z",
      "2026-10-13T12:00:00.000Z",
    ]);
  });

  it("skips slots that make a run of back-to-back meetings too long", () => {
    const rules = {
      ...SLOT_RULES,
      attendees: [
        {
          busy: busyAt(["09:00", "12:00"]),
          email: REQUESTER,
          required: true,
          timeZone: LONDON,
        },
      ],
      durationMinutes: 30,
      lunchMinutes: 0,
      maxResults: 3,
      timeMaxMs: london("13:00"),
      timeMinMs: london("12:00"),
      timeZone: LONDON,
    };

    // 12:00 would make a 3.5-hour run. 12:30 leaves a break.
    expect(starts(slotsFor(rules))).toEqual(["2026-10-13T11:30:00.000Z"]);
    expect(starts(slotsFor({ ...rules, maxBackToBackMinutes: 240 }))).toEqual([
      "2026-10-13T11:00:00.000Z",
      "2026-10-13T11:30:00.000Z",
    ]);
  });

  it("keeps lunch in each attendee's own time zone", () => {
    const slots = slotsFor({
      ...SLOT_RULES,
      attendees: [
        { busy: [], email: REQUESTER, required: true, timeZone: LONDON },
        {
          // 12:30-14:00 in New York (UTC-4), so lunch fits only 11:30-12:30.
          busy: [
            {
              startMs: Date.parse("2026-10-13T16:30:00Z"),
              endMs: Date.parse("2026-10-13T18:00:00Z"),
            },
          ],
          email: "bob@example.com",
          required: true,
          timeZone: "America/New_York",
        },
      ],
      durationMinutes: 30,
      maxResults: 3,
      // 11:00-12:00 in New York, 16:00-17:00 in London.
      timeMaxMs: Date.parse("2026-10-13T16:00:00Z"),
      timeMinMs: Date.parse("2026-10-13T15:00:00Z"),
      timeZone: LONDON,
    });

    // 11:30 in New York would take Bob's lunch break.
    expect(starts(slots)).toEqual(["2026-10-13T15:00:00.000Z"]);
  });

  it("keeps slots inside each attendee's own working hours", () => {
    // Monday 2026-10-12. With 08:00-17:00 hours, Los Angeles (UTC-7) and
    // London (UTC+1) share only 08:00-09:00 in Los Angeles.
    const slots = slotsFor({
      ...SLOT_RULES,
      attendees: [
        { busy: [], email: REQUESTER, required: true, timeZone: LA },
        {
          busy: [],
          email: "bob@example.com",
          required: true,
          timeZone: LONDON,
        },
        {
          busy: [],
          email: "dana@example.com",
          required: false,
          timeZone: "Asia/Tokyo",
        },
      ],
      durationMinutes: 60,
      maxResults: 3,
      timeMaxMs: Date.parse("2026-10-13T00:00:00Z"),
      timeMinMs: Date.parse("2026-10-12T00:00:00Z"),
      timeZone: LA,
      workdayStart: "08:00",
    });

    expect(slots).toEqual([
      {
        // 08:00 LA, 16:00 London, 00:00 Tuesday Tokyo.
        startMs: Date.parse("2026-10-12T15:00:00Z"),
        endMs: Date.parse("2026-10-12T16:00:00Z"),
        optionalConflicts: ["dana@example.com"],
      },
    ]);
  });
});

describe("accountChooserLink", () => {
  const ACCOUNT = "junior@example.com";
  // `eid` is base64 for "event1 junior@example.com".
  const LINK =
    "https://www.google.com/calendar/event?eid=ZXZlbnQxIGp1bmlvckBleGFtcGxlLmNvbQ==&ctz=Europe/London";
  const CHOOSER = `https://accounts.google.com/AccountChooser?hd=example.com&continue=${encodeURIComponent(LINK)}`;

  it("sends an event link through AccountChooser for Junior's domain", () => {
    const chooser = accountChooserLink(LINK, ACCOUNT);
    expect(chooser).toBe(CHOOSER);
    // The event link and all its params come back unchanged.
    expect(new URL(chooser).searchParams.get("continue")).toBe(LINK);
    // People paste shared links back in, so the event id still resolves.
    expect(parseEventId(chooser)).toBe("event1");
  });

  it("keeps a link that already goes through AccountChooser", () => {
    expect(accountChooserLink(CHOOSER, ACCOUNT)).toBe(CHOOSER);
  });

  it("keeps the link without a Workspace domain", () => {
    expect(accountChooserLink(LINK, "junior")).toBe(LINK);
    expect(accountChooserLink(LINK, "junior@gmail.com")).toBe(LINK);
  });
});

describe("recurrenceRule", () => {
  it("builds Google recurrence rules for common series", () => {
    expect(recurrenceRule({ frequency: "weekly", interval: 2 })).toBe(
      "RRULE:FREQ=WEEKLY;INTERVAL=2",
    );
    expect(
      recurrenceRule({ count: 10, frequency: "weekdays", interval: 1 }),
    ).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10");
  });
});

describe("Google Calendar tools", () => {
  beforeEach(() => {
    stubGoogleEnv();
    vi.useFakeTimers({ now: Date.parse("2026-10-08T12:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("checks the requester and attendees in their own time zones on the requested days, and reports people it could not check", async () => {
    const { fetch, tools } = calendarTools(
      Response.json({
        calendars: {
          // The requester says this block over the whole search is a hold.
          [REQUESTER]: {
            busy: [
              { start: "2026-10-26T16:00:00Z", end: "2026-11-09T17:00:00Z" },
            ],
          },
          "bob@example.com": {
            busy: [
              { start: "2026-10-27T13:00:00Z", end: "2026-10-27T17:00:00Z" },
            ],
          },
          "carol@example.com": { busy: [], errors: [{ reason: "notFound" }] },
        },
      }),
      Response.json({ timeZone: "America/New_York" }),
      Response.json({}, { status: 404 }),
      Response.json({ timeZone: LA }),
    );

    const result = await tools["findMeetingTimes"].execute(
      tools["findMeetingTimes"].prepareArguments!({
        attendees: ["Bob@example.com", "carol@example.com"],
        max_results: 1,
        optional_attendees: [REQUESTER],
        // 14 days on the Los Angeles clock, from Monday 09:00 PDT to Monday
        // 09:00 PST. Daylight saving ends inside it, so it is 14 days and
        // one hour long.
        time_max: "2026-11-09T17:00:00Z",
        time_min: "2026-10-26T16:00:00Z",
        time_zone: LA,
        weekdays: ["Tue"],
      }),
      { toolCallId: "call-1" },
    );

    const [freeBusy, ...timeZones] = fetch.mock.calls.map((call) => call[0]);
    expect(freeBusy.operation).toBe("google.calendar.freebusy.query");
    expect(freeBusy.provider).toBe("google");
    expect((await freeBusy.request.json()).items).toEqual([
      { id: "bob@example.com" },
      { id: "carol@example.com" },
      { id: REQUESTER },
    ]);
    const bobZone = new URL(timeZones[0].request.url);
    expect(timeZones[0].operation).toBe("google.calendar.events.list");
    expect(bobZone.pathname).toBe(
      "/calendar/v3/calendars/bob%40example.com/events",
    );
    // Without a timeZone parameter, Google returns the calendar's own zone.
    expect(bobZone.searchParams.has("timeZone")).toBe(false);
    expect(result).toMatchObject({
      checked: [
        { email: "bob@example.com", time_zone: "America/New_York" },
        { email: REQUESTER, time_zone: LA },
      ],
      // Tuesday 13:30 in Los Angeles, 16:30 for Bob in New York. 13:00 would
      // stretch his 09:00-13:00 run and take his lunch break, and 16:30
      // keeps the most of his afternoon free. The requester listed
      // themselves as optional, so the hold does not block it. Monday is
      // open earlier, but only Tuesdays were asked for.
      slots: [
        {
          optional_conflicts: [REQUESTER],
          other_time_zone_labels: ["Tue, Oct 27, 16:30 – 17:00 EDT"],
          start: "2026-10-27T20:30:00.000Z",
        },
      ],
      unavailable: [{ email: "carol@example.com", reason: "notFound" }],
    });
  });

  it("searches later hours for people who often meet others late", async () => {
    // Now is Thursday 2026-10-08 12:00 UTC. London is UTC+1, Los Angeles
    // UTC-7. Bob had calls with Alice until 22:00 London on three weekdays.
    const event = (
      date: string,
      start: string,
      end: string,
      attendees: Array<{ email: string; responseStatus?: string }>,
    ) => ({
      attendees,
      end: { dateTime: `${date}T${end}:00Z` },
      start: { dateTime: `${date}T${start}:00Z` },
    });
    const call = (date: string) =>
      event(date, "19:00", "21:00", [
        { email: REQUESTER },
        { email: "bob@example.com" },
      ]);
    const { fetch, tools } = calendarTools(
      Response.json({
        calendars: {
          [REQUESTER]: { busy: [] },
          "bob@example.com": { busy: [] },
        },
      }),
      Response.json({ timeZone: LA }),
      Response.json({
        items: [
          call("2026-09-29"),
          call("2026-10-01"),
          call("2026-10-06"),
          // A call on a weekend does not count.
          call("2026-10-03"),
          // Google leaves out `start` and `end` of all-day events, such as a
          // working location, because the field mask asks for `dateTime`.
          {},
          // Do-not-schedule blocks that Bob holds alone are not meetings.
          ...["2026-09-30", "2026-10-02", "2026-10-05"].map((date) =>
            event(date, "06:00", "08:00", []),
          ),
          // Neither are late calls that Bob declined.
          ...["2026-09-30", "2026-10-02", "2026-10-05"].map((date) =>
            event(date, "21:00", "22:00", [
              { email: REQUESTER },
              { email: "bob@example.com", responseStatus: "declined" },
            ]),
          ),
        ],
        timeZone: "Europe/London",
      }),
    );

    const result = await tools["findMeetingTimes"].execute(
      tools["findMeetingTimes"].prepareArguments!({
        attendees: ["bob@example.com"],
        max_results: 2,
        time_max: "2026-10-13T00:00:00Z",
        time_min: "2026-10-12T00:00:00Z",
        time_zone: LA,
      }),
      { toolCallId: "call-late" },
    );

    // Junior reads the last 3 weeks of each person's events.
    const history = new URL(fetch.mock.calls[2]![0].request.url).searchParams;
    expect(history.get("timeMin")).toBe("2026-09-17T12:00:00.000Z");
    expect(history.get("timeMax")).toBe("2026-10-08T12:00:00.000Z");
    // With 09:00-17:00 for both, Los Angeles and London share no time.
    // Bob's hours now run to 22:00 London, which is 14:00 in Los Angeles.
    expect(result).toMatchObject({
      checked: [
        {
          email: REQUESTER,
          working_hours: {
            from_meetings: false,
            workday_end: "17:00",
            workday_start: "09:00",
          },
        },
        {
          email: "bob@example.com",
          working_hours: {
            from_meetings: true,
            workday_end: "22:00",
            workday_start: "09:00",
          },
        },
      ],
    });
    expect(result.slots.length).toBeGreaterThan(0);
    for (const slot of result.slots) {
      expect(Date.parse(slot.start)).toBeGreaterThanOrEqual(
        Date.parse("2026-10-12T16:00:00Z"),
      );
      expect(Date.parse(slot.end)).toBeLessThanOrEqual(
        Date.parse("2026-10-12T21:00:00Z"),
      );
    }
  });

  it("refuses people outside the allowed Workspace domains", async () => {
    const { fetch, tools } = calendarTools();

    await expect(
      tools["createCalendarEvent"].execute(
        tools["createCalendarEvent"].prepareArguments!({
          attendees: ["mallory@elsewhere.com"],
          end: "2026-10-12T10:30:00-07:00",
          start: "2026-10-12T10:00:00-07:00",
          time_zone: "America/Los_Angeles",
          title: "Sync",
        }),
        { toolCallId: "call-2" },
      ),
    ).rejects.toBeInstanceOf(PluginToolInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates one event per tool call and returns the existing event on retry", async () => {
    const event = {
      attendees: [
        { email: REQUESTER },
        { displayName: "Bob Smith", email: "bob@example.com" },
      ],
      end: { dateTime: "2026-10-12T10:30:00-07:00" },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://calendar.google.com/event?eid=1",
      start: { dateTime: "2026-10-12T10:00:00-07:00" },
      summary: "Sync",
    };
    const input = {
      attendees: ["bob@example.com"],
      end: "2026-10-12T10:30:00-07:00",
      location: "Bug Tracer",
      optional_attendees: ["dana@example.com", REQUESTER],
      repeat: { frequency: "weekly" },
      start: "2026-10-12T10:00:00-07:00",
      time_zone: "America/Los_Angeles",
      title: "Sync",
    };
    const first = calendarTools(Response.json({ ...event, id: "x" }));
    await first.tools["createCalendarEvent"].execute(
      first.tools["createCalendarEvent"].prepareArguments!(input),
      { toolCallId: "call-3" },
    );
    const create = first.fetch.mock.calls[0][0];
    const url = new URL(create.request.url);
    const body = await create.request.json();
    expect(create.operation).toBe("google.calendar.event.create");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(body).toMatchObject({
      // The requester stays required even when also listed as optional.
      attendees: [
        { email: REQUESTER },
        { email: "bob@example.com" },
        { email: "dana@example.com", optional: true },
      ],
      location: "Bug Tracer",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      conferenceData: {
        createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
      summary: "Sync",
    });
    expect(body.id).toMatch(/^[a-v0-9]{40}$/);

    const retry = calendarTools(
      Response.json({ error: { message: "duplicate" } }, { status: 409 }),
      Response.json({ ...event, id: body.id }),
    );
    const result = await retry.tools["createCalendarEvent"].execute(
      retry.tools["createCalendarEvent"].prepareArguments!(input),
      { toolCallId: "call-3" },
    );
    expect((await retry.fetch.mock.calls[0][0].request.json()).id).toBe(
      body.id,
    );
    expect(retry.fetch.mock.calls[1][0].operation).toBe(
      "google.calendar.event.get",
    );
    expect(result).toMatchObject({
      created: false,
      event_id: body.id,
      label: "Mon, Oct 12, 10:00 – 10:30 PDT",
      video_call_url: "https://meet.google.com/abc-defg-hij",
    });
    // Core saves this annotation and shows its card with the next reply.
    expect(
      annotatedObjectSchema.array().parse(result.objectAnnotations),
    ).toEqual([
      {
        action: "created",
        kind: "object",
        key: body.id,
        subject: { id: body.id, kind: "calendar_event" },
        objectType: "calendar_event",
        title: "Sync",
        // The link opens in each viewer's Workspace account.
        url: `https://accounts.google.com/AccountChooser?hd=example.com&continue=${encodeURIComponent("https://calendar.google.com/event?eid=1")}`,
      },
    ]);
  });
  it("reads a colleague's calendar and reports calendars Junior cannot see", async () => {
    const { fetch, tools } = calendarTools(
      Response.json({
        items: [
          {
            attendees: [
              { email: "bob@example.com", responseStatus: "accepted" },
              { email: REQUESTER, optional: true, responseStatus: "declined" },
              {
                email: "room@resource.calendar.google.com",
                resource: true,
              },
            ],
            end: { dateTime: "2026-10-12T10:30:00-07:00" },
            id: "event1",
            organizer: { email: "bob@example.com" },
            start: { dateTime: "2026-10-12T10:00:00-07:00" },
            summary: "Planning",
          },
          // Busy block on a calendar shared as free/busy only.
          {
            end: { dateTime: "2026-10-12T12:00:00-07:00" },
            id: "event2",
            start: { dateTime: "2026-10-12T11:00:00-07:00" },
          },
          // One occurrence of a weekly series that Junior organizes.
          {
            end: { dateTime: "2026-10-12T12:30:00-07:00" },
            id: "series1_20261012T190000Z",
            organizer: { email: "Junior@example.com" },
            recurringEventId: "series1",
            start: { dateTime: "2026-10-12T12:00:00-07:00" },
            summary: "Weekly 1:1",
          },
          // All-day events: Google's end date is exclusive.
          {
            end: { date: "2026-10-13" },
            id: "allDay",
            start: { date: "2026-10-12" },
          },
          {
            end: { date: "2026-10-15" },
            id: "offsite",
            start: { date: "2026-10-12" },
          },
          {
            end: { dateTime: "2026-10-12T14:00:00-07:00" },
            id: "event3",
            start: { dateTime: "2026-10-12T13:00:00-07:00" },
            status: "cancelled",
          },
        ],
      }),
      Response.json({ error: { message: "Not Found" } }, { status: 404 }),
    );
    const input = {
      calendar: "Bob@example.com",
      time_max: "2026-10-13T00:00:00Z",
      time_min: "2026-10-12T00:00:00Z",
      time_zone: "America/Los_Angeles",
    };

    const result = await tools["listCalendarEvents"].execute(
      tools["listCalendarEvents"].prepareArguments!(input),
      { toolCallId: "call-4" },
    );
    const call = fetch.mock.calls[0][0];
    const url = new URL(call.request.url);
    expect(call.operation).toBe("google.calendar.events.list");
    expect(url.pathname).toBe(
      "/calendar/v3/calendars/bob%40example.com/events",
    );
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(result).toMatchObject({
      events: [
        {
          // Room resources are left out.
          attendees: [
            { email: "bob@example.com", response: "accepted" },
            { email: REQUESTER, optional: true, response: "declined" },
          ],
          event_id: "event1",
          organized_by_junior: false,
          organizer: "bob@example.com",
          title: "Planning",
        },
        { event_id: "event2", organized_by_junior: false },
        {
          event_id: "series1_20261012T190000Z",
          organized_by_junior: true,
          series_event_id: "series1",
        },
        { end: "2026-10-12", event_id: "allDay", label: "2026-10-12, all day" },
        {
          end: "2026-10-14",
          event_id: "offsite",
          label: "2026-10-12 to 2026-10-14, all day",
        },
      ],
      visible: true,
    });
    expect(result.events[1]).not.toHaveProperty("title");

    const hidden = await tools["listCalendarEvents"].execute(
      tools["listCalendarEvents"].prepareArguments!(input),
      { toolCallId: "call-5" },
    );
    expect(hidden).toMatchObject({ events: [], visible: false });
  });

  it("reads Junior's own calendar when no calendar is given", async () => {
    const { fetch, tools } = calendarTools(Response.json({ items: [] }));

    const result = await tools["listCalendarEvents"].execute(
      tools["listCalendarEvents"].prepareArguments!({
        time_max: "2026-10-13T00:00:00Z",
        time_min: "2026-10-12T00:00:00Z",
        time_zone: "America/Los_Angeles",
      }),
      { toolCallId: "call-own" },
    );
    expect(new URL(fetch.mock.calls[0][0].request.url).pathname).toBe(
      "/calendar/v3/calendars/primary/events",
    );
    expect(result).toMatchObject({
      calendar: "junior@example.com",
      visible: true,
    });
  });

  it("changes Junior's event only for people invited to it", async () => {
    const event = {
      // Google can return directory capitalization.
      attendees: [
        { email: REQUESTER.toUpperCase(), responseStatus: "accepted" },
        { email: "Bob@example.com", responseStatus: "needsAction" },
        { email: "Carol@example.com", responseStatus: "accepted" },
      ],
      end: { dateTime: "2026-10-12T10:30:00-07:00" },
      id: "event1",
      organizer: { email: "junior@example.com", self: true },
      start: { dateTime: "2026-10-12T10:00:00-07:00" },
      summary: "Sync",
    };
    const input = {
      add_attendees: ["carol@example.com"],
      add_optional_attendees: ["dana@example.com"],
      end: "2026-10-13T11:30:00-07:00",
      event_id: "event1",
      location: "Bug Tracer",
      remove_attendees: ["bob@example.com"],
      start: "2026-10-13T11:00:00-07:00",
      time_zone: "America/Los_Angeles",
    };

    const outsider = calendarTools(
      Response.json({ ...event, attendees: [{ email: "bob@example.com" }] }),
    );
    await expect(
      outsider.tools["updateCalendarEvent"].execute(
        outsider.tools["updateCalendarEvent"].prepareArguments!(input),
        { toolCallId: "call-6" },
      ),
    ).rejects.toBeInstanceOf(PluginToolInputError);
    expect(outsider.fetch).toHaveBeenCalledTimes(1);

    const { fetch, tools } = calendarTools(
      Response.json(event),
      Response.json({
        ...event,
        attendees: [
          { email: REQUESTER },
          { email: "carol@example.com" },
          { email: "dana@example.com", optional: true },
        ],
        end: { dateTime: input.end },
        start: { dateTime: input.start },
        // Someone renamed the event in Calendar past the annotation limit.
        summary: "S".repeat(600),
        updated: "2026-10-08T12:00:00.000Z",
      }),
    );
    const result = await tools["updateCalendarEvent"].execute(
      tools["updateCalendarEvent"].prepareArguments!(input),
      { toolCallId: "call-7" },
    );
    const patch = fetch.mock.calls[1][0];
    expect(patch.operation).toBe("google.calendar.event.update");
    expect(patch.request.method).toBe("PATCH");
    expect(new URL(patch.request.url).searchParams.get("sendUpdates")).toBe(
      "all",
    );
    expect(await patch.request.json()).toEqual({
      // Existing attendees keep their response status.
      attendees: [
        { email: REQUESTER.toUpperCase(), responseStatus: "accepted" },
        { email: "Carol@example.com", responseStatus: "accepted" },
        { email: "dana@example.com", optional: true },
      ],
      end: { dateTime: input.end, timeZone: "America/Los_Angeles" },
      location: "Bug Tracer",
      start: { dateTime: input.start, timeZone: "America/Los_Angeles" },
    });
    expect(result).toMatchObject({
      attendees: [
        { email: REQUESTER },
        { email: "carol@example.com" },
        { email: "dana@example.com", optional: true },
      ],
      event_id: "event1",
      label: "Tue, Oct 13, 11:00 – 11:30 PDT",
      // The same key replaces the saved Annotation. Its card reads the new
      // time live.
      objectAnnotations: [{ key: "event1", title: "S".repeat(512) }],
      start: input.start,
    });
  });

  it("cancels only Junior's events, for people invited to them, and emails attendees", async () => {
    const event = {
      attendees: [{ email: REQUESTER }, { email: "bob@example.com" }],
      end: { dateTime: "2026-10-12T10:30:00-07:00" },
      id: "event1",
      organizer: { email: "junior@example.com", self: true },
      start: { dateTime: "2026-10-12T10:00:00-07:00" },
      summary: "Sync",
    };
    // People often paste the Google Calendar link instead of an id.
    const input = {
      event_id:
        "https://www.google.com/calendar/event?eid=ZXZlbnQxIGp1bmlvckBleGFtcGxlLmNvbQ==",
      time_zone: "America/Los_Angeles",
    };
    const cancel = (tools: ReturnType<typeof calendarTools>["tools"]) =>
      tools["cancelCalendarEvent"].execute(
        tools["cancelCalendarEvent"].prepareArguments!(input),
        { toolCallId: "call-cancel" },
      );

    // Junior is only invited; someone else organizes it.
    const invited = calendarTools(
      Response.json({ ...event, organizer: { email: "bob@example.com" } }),
    );
    await expect(cancel(invited.tools)).rejects.toBeInstanceOf(
      PluginToolInputError,
    );
    const outsider = calendarTools(
      Response.json({ ...event, attendees: [{ email: "bob@example.com" }] }),
    );
    await expect(cancel(outsider.tools)).rejects.toBeInstanceOf(
      PluginToolInputError,
    );
    expect(invited.fetch).toHaveBeenCalledTimes(1);
    expect(outsider.fetch).toHaveBeenCalledTimes(1);

    const { fetch, tools } = calendarTools(
      Response.json(event),
      new Response(null, { status: 204 }),
    );
    const result = await cancel(tools);
    const del = fetch.mock.calls[1][0];
    const url = new URL(del.request.url);
    expect(del.operation).toBe("google.calendar.event.delete");
    expect(del.request.method).toBe("DELETE");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events/event1");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(result).toMatchObject({
      cancelled: true,
      event_id: "event1",
      // The card stays. It reads that the event is cancelled live.
      objectAnnotations: [{ key: "event1", title: "Sync" }],
      title: "Sync",
    });

    // A retry after Google already deleted the event is not an error.
    const retry = calendarTools(
      Response.json(event),
      Response.json({ error: { message: "Gone" } }, { status: 410 }),
    );
    expect(await cancel(retry.tools)).toMatchObject({ cancelled: false });

    // A later call reads the deleted event back as a stub without attendees.
    for (const deleted of [
      Response.json({ id: "event1", status: "cancelled" }),
      Response.json({ error: { message: "Deleted" } }, { status: 410 }),
    ]) {
      const again = calendarTools(deleted);
      expect(await cancel(again.tools)).toEqual({
        target: "cancelCalendarEvent",
        cancelled: false,
        event_id: "event1",
      });
      expect(again.fetch).toHaveBeenCalledTimes(1);
    }
  });
});

describe("Calendar changes for Guardian", () => {
  beforeEach(() => stubGoogleEnv());
  afterEach(() => vi.unstubAllEnvs());

  async function audience(response: Response) {
    const tool = googlePlugin().hooks!.tools!()["updateCalendarEvent"]!;
    const fetch = vi.fn().mockResolvedValueOnce(response);
    const result = await tool.guardian!(
      { event_id: "event1" } as never,
      { egress: { fetch } } as never,
    );
    return result.audience;
  }

  it("counts an event with an outside attendee, or no answer, as world", async () => {
    const attendees = (...emails: string[]) =>
      Response.json({ attendees: emails.map((email) => ({ email })) });
    expect(await audience(attendees(REQUESTER))).toBe("internal");
    expect(await audience(attendees(REQUESTER, "bob@partner.test"))).toBe(
      "world",
    );
    expect(await audience(new Response("nope", { status: 500 }))).toBe("world");
    // A booked room reads nothing.
    const room = {
      email: "c_188@resource.calendar.google.com",
      resource: true,
    };
    expect(
      await audience(
        Response.json({ attendees: [{ email: REQUESTER }, room] }),
      ),
    ).toBe("internal");
  });
});
