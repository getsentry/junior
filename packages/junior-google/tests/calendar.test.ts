import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
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
    },
  } as never);
  return { fetch, tools };
}

describe("findFreeSlots", () => {
  it("offers non-overlapping weekday slots inside local working hours", () => {
    // Friday 2026-10-09 through Monday 2026-10-12, Los Angeles (UTC-7).
    const slots = findFreeSlots({
      busy: [
        // Busy Friday 09:00-12:00 local.
        {
          startMs: Date.parse("2026-10-09T16:00:00Z"),
          endMs: Date.parse("2026-10-09T19:00:00Z"),
        },
      ],
      durationMinutes: 60,
      maxResults: 4,
      timeMaxMs: Date.parse("2026-10-13T00:00:00Z"),
      timeMinMs: Date.parse("2026-10-09T15:00:00Z"),
      timeZone: "America/Los_Angeles",
      workdayEnd: "14:00",
      workdayStart: "09:00",
    });

    expect(slots.map((slot) => new Date(slot.startMs).toISOString())).toEqual([
      // Friday 12:00 and 13:00 local, then skip the weekend.
      "2026-10-09T19:00:00.000Z",
      "2026-10-09T20:00:00.000Z",
      // Monday 09:00 and 10:00 local.
      "2026-10-12T16:00:00.000Z",
      "2026-10-12T17:00:00.000Z",
    ]);
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

  it("checks the requester and attendees, and reports people it could not check", async () => {
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
    );

    const result = await tools.findMeetingTimes!.execute!(
      tools.findMeetingTimes!.prepareArguments!({
        attendees: ["Bob@example.com", "carol@example.com"],
        durationMinutes: 30,
        maxResults: 1,
        timeMax: "2026-10-13T00:00:00Z",
        timeMin: "2026-10-12T16:00:00Z",
        timeZone: "America/Los_Angeles",
      }),
      { toolCallId: "call-1" },
    );

    const call = fetch.mock.calls[0]![0];
    expect(call.operation).toBe("google.calendar.freebusy.query");
    expect(call.provider).toBe("google");
    expect((await call.request.json()).items).toEqual([
      { id: REQUESTER },
      { id: "bob@example.com" },
      { id: "carol@example.com" },
    ]);
    expect(result).toMatchObject({
      checked: [REQUESTER, "bob@example.com"],
      slots: [{ start: "2026-10-12T17:00:00.000Z" }],
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
      attendees: [{ email: REQUESTER }, { email: "bob@example.com" }],
      end: { dateTime: "2026-10-12T10:30:00-07:00" },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://calendar.google.com/event?eid=1",
      start: { dateTime: "2026-10-12T10:00:00-07:00" },
    };
    const input = {
      attendees: ["bob@example.com"],
      end: "2026-10-12T10:30:00-07:00",
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
      attendees: [{ email: REQUESTER }, { email: "bob@example.com" }],
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
      videoCallUrl: "https://meet.google.com/abc-defg-hij",
    });
  });
  it("reads a colleague's calendar and reports calendars Junior cannot see", async () => {
    const { fetch, tools } = calendarTools(
      Response.json({
        items: [
          {
            attendees: [{ email: "bob@example.com" }, { email: REQUESTER }],
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
          attendees: ["bob@example.com", REQUESTER],
          eventId: "event1",
          organizer: "bob@example.com",
          title: "Planning",
        },
        { eventId: "event2" },
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
      end: "2026-10-13T11:30:00-07:00",
      eventId: "event1",
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
        attendees: [{ email: REQUESTER }, { email: "carol@example.com" }],
        end: { dateTime: input.end },
        start: { dateTime: input.start },
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
      ],
      end: { dateTime: input.end, timeZone: "America/Los_Angeles" },
      start: { dateTime: input.start, timeZone: "America/Los_Angeles" },
    });
    expect(result).toMatchObject({
      attendees: [REQUESTER, "carol@example.com"],
      eventId: "event1",
      start: input.start,
    });
  });
});
