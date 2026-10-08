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
});
