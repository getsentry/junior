import {
  objectAnnotationSchema,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { recurrenceRule } from "../src/tools/create-event";
import { findFreeSlots } from "../src/tools/find-meeting-times";
import { stubGoogleEnv } from "./fixture";

const REQUESTER = "alice@example.com";

function calendarTools(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const tools = googlePlugin().hooks!.tools!({
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

describe("findFreeSlots", () => {
  it("spreads non-overlapping weekday slots across days inside local working hours", () => {
    // Friday 2026-10-09 through Monday 2026-10-12, Los Angeles (UTC-7).
    const slots = findFreeSlots({
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
      workdayStart: "09:00",
    });

    expect(slots.map((slot) => new Date(slot.startMs).toISOString())).toEqual([
      // Friday 12:00 and 13:00 local, then skip the weekend.
      "2026-10-09T19:00:00.000Z",
      "2026-10-09T20:00:00.000Z",
      // Monday 09:00, then the Monday slot farthest from it.
      "2026-10-12T16:00:00.000Z",
      "2026-10-12T20:00:00.000Z",
    ]);
  });

  it("keeps slots inside each attendee's own working hours", () => {
    // Monday 2026-10-12. With 08:00-17:00 hours, Los Angeles (UTC-7) and
    // London (UTC+1) share only 08:00-09:00 in Los Angeles.
    const slots = findFreeSlots({
      attendees: [
        { busy: [], email: REQUESTER, required: true, timeZone: LA },
        {
          busy: [],
          email: "bob@example.com",
          required: true,
          timeZone: "Europe/London",
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
      workdayEnd: "17:00",
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

  it("checks the requester and attendees in their own time zones, and reports people it could not check", async () => {
    const { fetch, tools } = calendarTools(
      Response.json({
        calendars: {
          [REQUESTER]: { busy: [] },
          "bob@example.com": {
            busy: [
              { start: "2026-10-12T16:00:00Z", end: "2026-10-12T17:00:00Z" },
            ],
          },
          "carol@example.com": { busy: [], errors: [{ reason: "notFound" }] },
        },
      }),
      Response.json({ timeZone: LA }),
      Response.json({ timeZone: "America/New_York" }),
      Response.json({}, { status: 404 }),
    );

    const result = await tools.findMeetingTimes!.execute!(
      tools.findMeetingTimes!.prepareArguments!({
        attendees: ["Bob@example.com", "carol@example.com"],
        maxResults: 1,
        timeMax: "2026-10-13T00:00:00Z",
        timeMin: "2026-10-12T16:00:00Z",
        timeZone: LA,
      }),
      { toolCallId: "call-1" },
    );

    const [freeBusy, ...timeZones] = fetch.mock.calls.map((call) => call[0]);
    expect(freeBusy.operation).toBe("google.calendar.freebusy.query");
    expect(freeBusy.provider).toBe("google");
    expect((await freeBusy.request.json()).items).toEqual([
      { id: REQUESTER },
      { id: "bob@example.com" },
      { id: "carol@example.com" },
    ]);
    const bobZone = new URL(timeZones[1].request.url);
    expect(timeZones[1].operation).toBe("google.calendar.events.list");
    expect(bobZone.pathname).toBe(
      "/calendar/v3/calendars/bob%40example.com/events",
    );
    // Without a timeZone parameter, Google returns the calendar's own zone.
    expect(bobZone.searchParams.has("timeZone")).toBe(false);
    expect(result).toMatchObject({
      checked: [
        { email: REQUESTER, timeZone: LA },
        { email: "bob@example.com", timeZone: "America/New_York" },
      ],
      // 10:00 in Los Angeles, after Bob's 12:00-13:00 in New York.
      slots: [
        {
          otherTimeZoneLabels: ["Mon, Oct 12, 13:00 – 13:30 EDT"],
          start: "2026-10-12T17:00:00.000Z",
        },
      ],
      unavailable: [{ email: "carol@example.com", reason: "notFound" }],
    });
  });

  it("refuses people outside the allowed Workspace domains", async () => {
    const { fetch, tools } = calendarTools();

    await expect(
      tools.createCalendarEvent!.execute!(
        tools.createCalendarEvent!.prepareArguments!({
          attendees: ["mallory@elsewhere.com"],
          end: "2026-10-12T10:30:00-07:00",
          start: "2026-10-12T10:00:00-07:00",
          timeZone: "America/Los_Angeles",
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
      optionalAttendees: ["dana@example.com", REQUESTER],
      repeat: { frequency: "weekly" },
      start: "2026-10-12T10:00:00-07:00",
      timeZone: "America/Los_Angeles",
      title: "Sync",
    };
    const first = calendarTools(Response.json({ ...event, id: "x" }));
    await first.tools.createCalendarEvent!.execute!(
      first.tools.createCalendarEvent!.prepareArguments!(input),
      { toolCallId: "call-3" },
    );
    const create = first.fetch.mock.calls[0]![0];
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
    const result = await retry.tools.createCalendarEvent!.execute!(
      retry.tools.createCalendarEvent!.prepareArguments!(input),
      { toolCallId: "call-3" },
    );
    expect((await retry.fetch.mock.calls[0]![0].request.json()).id).toBe(
      body.id,
    );
    expect(retry.fetch.mock.calls[1]![0].operation).toBe(
      "google.calendar.event.get",
    );
    expect(result).toMatchObject({
      created: false,
      eventId: body.id,
      label: "Mon, Oct 12, 10:00 – 10:30 PDT",
      videoCallUrl: "https://meet.google.com/abc-defg-hij",
    });
    // Core saves this annotation and shows its card with the next reply.
    expect(
      objectAnnotationSchema.array().parse(result.objectAnnotations),
    ).toEqual([
      {
        kind: "object",
        key: body.id,
        label: "Oct 12",
        objectType: "calendar_event",
        title: "Sync",
        url: "https://calendar.google.com/event?eid=1",
        facts: {
          type: "calendar_event",
          when: "Mon, Oct 12, 10:00 – 10:30 PDT",
          attendees: [REQUESTER, "Bob Smith"],
        },
      },
    ]);
  });
  it("turns on Meet auto-recording when asked, and reports when Google refuses", async () => {
    const event = {
      attendees: [{ email: REQUESTER }],
      conferenceData: { conferenceId: "abc-defg-hij" },
      end: { dateTime: "2026-10-12T11:00:00-07:00" },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      id: "event1",
      start: { dateTime: "2026-10-12T10:00:00-07:00" },
      summary: "INC-123 postmortem",
    };
    const input = {
      attendees: [],
      description: "Timeline: https://example.com/inc-123",
      end: "2026-10-12T11:00:00-07:00",
      record: true,
      start: "2026-10-12T10:00:00-07:00",
      timeZone: "America/Los_Angeles",
      title: "INC-123 postmortem",
    };

    const { fetch, tools } = calendarTools(
      Response.json(event),
      Response.json({ name: "spaces/jQCFfuBOdN5z" }),
      Response.json({ name: "spaces/jQCFfuBOdN5z" }),
    );
    const result = await tools.createCalendarEvent!.execute!(
      tools.createCalendarEvent!.prepareArguments!(input),
      { toolCallId: "call-rec" },
    );
    const createBody = await fetch.mock.calls[0]![0].request.json();
    // Invitees see the notice before they join.
    expect(createBody.description).toBe(
      "Timeline: https://example.com/inc-123\n\nThis meeting is recorded. Google Meet starts the recording automatically.",
    );
    const get = fetch.mock.calls[1]![0];
    expect(get.operation).toBe("google.meet.space.get");
    expect(get.request.url).toBe(
      "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
    );
    const update = fetch.mock.calls[2]![0];
    const updateUrl = new URL(update.request.url);
    expect(update.operation).toBe("google.meet.space.update");
    expect(update.request.method).toBe("PATCH");
    expect(updateUrl.pathname).toBe("/v2/spaces/jQCFfuBOdN5z");
    expect(updateUrl.searchParams.get("updateMask")).toBe(
      "config.artifactConfig.recordingConfig.autoRecordingGeneration",
    );
    expect(await update.request.json()).toEqual({
      config: {
        artifactConfig: { recordingConfig: { autoRecordingGeneration: "ON" } },
      },
    });
    expect(result).toMatchObject({ created: true, recording: "on" });

    // The invites are already sent, so a refusal is reported, not thrown.
    const refused = calendarTools(
      Response.json(event),
      Response.json(
        { error: { message: "Request had insufficient scopes." } },
        { status: 403 },
      ),
    );
    const refusedResult = await refused.tools.createCalendarEvent!.execute!(
      refused.tools.createCalendarEvent!.prepareArguments!(input),
      { toolCallId: "call-rec-2" },
    );
    expect(refusedResult).toMatchObject({
      created: true,
      eventId: "event1",
      recording: "failed",
    });
    expect(refusedResult.recordingError).toContain("reconnect");
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
      timeMax: "2026-10-13T00:00:00Z",
      timeMin: "2026-10-12T00:00:00Z",
      timeZone: "America/Los_Angeles",
    };

    const result = await tools.listCalendarEvents!.execute!(
      tools.listCalendarEvents!.prepareArguments!(input),
      { toolCallId: "call-4" },
    );
    const call = fetch.mock.calls[0]![0];
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
          eventId: "event1",
          organizedByJunior: false,
          organizer: "bob@example.com",
          title: "Planning",
        },
        { eventId: "event2", organizedByJunior: false },
        {
          eventId: "series1_20261012T190000Z",
          organizedByJunior: true,
          seriesEventId: "series1",
        },
        { end: "2026-10-12", eventId: "allDay", label: "2026-10-12, all day" },
        {
          end: "2026-10-14",
          eventId: "offsite",
          label: "2026-10-12 to 2026-10-14, all day",
        },
      ],
      visible: true,
    });
    expect(result.events[1]).not.toHaveProperty("title");

    const hidden = await tools.listCalendarEvents!.execute!(
      tools.listCalendarEvents!.prepareArguments!(input),
      { toolCallId: "call-5" },
    );
    expect(hidden).toMatchObject({ events: [], visible: false });
  });

  it("reads Junior's own calendar when no calendar is given", async () => {
    const { fetch, tools } = calendarTools(Response.json({ items: [] }));

    const result = await tools.listCalendarEvents!.execute!(
      tools.listCalendarEvents!.prepareArguments!({
        timeMax: "2026-10-13T00:00:00Z",
        timeMin: "2026-10-12T00:00:00Z",
        timeZone: "America/Los_Angeles",
      }),
      { toolCallId: "call-own" },
    );
    expect(new URL(fetch.mock.calls[0]![0].request.url).pathname).toBe(
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
      addAttendees: ["carol@example.com"],
      addOptionalAttendees: ["dana@example.com"],
      end: "2026-10-13T11:30:00-07:00",
      eventId: "event1",
      location: "Bug Tracer",
      removeAttendees: ["bob@example.com"],
      start: "2026-10-13T11:00:00-07:00",
      timeZone: "America/Los_Angeles",
    };

    const outsider = calendarTools(
      Response.json({ ...event, attendees: [{ email: "bob@example.com" }] }),
    );
    await expect(
      outsider.tools.updateCalendarEvent!.execute!(
        outsider.tools.updateCalendarEvent!.prepareArguments!(input),
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
    const result = await tools.updateCalendarEvent!.execute!(
      tools.updateCalendarEvent!.prepareArguments!(input),
      { toolCallId: "call-7" },
    );
    const patch = fetch.mock.calls[1]![0];
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
      eventId: "event1",
      // The same key replaces the saved card with the new time.
      objectAnnotations: [
        {
          key: "event1",
          label: "Oct 13",
          facts: { when: "Tue, Oct 13, 11:00 – 11:30 PDT" },
          sourceUpdatedAt: "2026-10-08T12:00:00.000Z",
          title: "S".repeat(512),
        },
      ],
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
      eventId:
        "https://www.google.com/calendar/event?eid=ZXZlbnQxIGp1bmlvckBleGFtcGxlLmNvbQ==",
      timeZone: "America/Los_Angeles",
    };
    const cancel = (tools: ReturnType<typeof calendarTools>["tools"]) =>
      tools.cancelCalendarEvent!.execute!(
        tools.cancelCalendarEvent!.prepareArguments!(input),
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
    const del = fetch.mock.calls[1]![0];
    const url = new URL(del.request.url);
    expect(del.operation).toBe("google.calendar.event.delete");
    expect(del.request.method).toBe("DELETE");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events/event1");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(result).toMatchObject({
      cancelled: true,
      eventId: "event1",
      // The saved card now shows that the event is cancelled.
      objectAnnotations: [{ key: "event1", status: "cancelled" }],
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
        eventId: "event1",
      });
      expect(again.fetch).toHaveBeenCalledTimes(1);
    }
  });
});
