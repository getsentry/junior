import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { ACCOUNT_EMAIL, stubGoogleEnv } from "./fixture";

const REQUESTER = "alice@example.com";

function meetTools(...responses: Response[]) {
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
  const read = (eventId: string) =>
    tools.readMeetingTranscript!.execute!(
      tools.readMeetingTranscript!.prepareArguments!({ eventId }),
      { toolCallId: "call-1" },
    );
  return { fetch, read };
}

// Bob organizes the meeting and invited Junior and Alice.
const event = {
  attendees: [
    { email: "bob@example.com", responseStatus: "accepted" },
    { email: "Alice@example.com", responseStatus: "accepted" },
    { email: ACCOUNT_EMAIL, responseStatus: "needsAction", self: true },
  ],
  conferenceData: {
    conferenceId: "abc-defg-hij",
    conferenceSolution: { key: { type: "hangoutsMeet" } },
  },
  end: { dateTime: "2026-10-12T10:30:00-07:00" },
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  id: "event1",
  organizer: { email: "bob@example.com" },
  start: { dateTime: "2026-10-12T10:00:00-07:00" },
  summary: "Weekly triage",
};

describe("Google Meet transcripts", () => {
  beforeEach(() => {
    stubGoogleEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads Meet only for meetings where Junior and the requester are invited", async () => {
    const outsider = meetTools(
      Response.json({
        ...event,
        attendees: [{ email: "bob@example.com" }, event.attendees[2]],
      }),
    );
    await expect(outsider.read("event1")).rejects.toBeInstanceOf(
      PluginToolInputError,
    );
    const notInvited = meetTools(
      Response.json({ ...event, attendees: event.attendees.slice(0, 2) }),
    );
    await expect(notInvited.read("event1")).rejects.toThrow(
      "Junior is not invited",
    );
    // Neither request reached Meet.
    for (const { fetch } of [outsider, notInvited]) {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![0].operation).toBe(
        "google.calendar.event.get",
      );
    }

    // Someone copied the Meet link onto their own event with Junior, but they
    // are not invited to the meeting that owns the link.
    const copiedLink = meetTools(
      Response.json(event),
      Response.json({
        items: [
          event,
          { ...event, attendees: event.attendees.slice(0, 1), id: "other" },
        ],
      }),
    );
    await expect(copiedLink.read("event1")).rejects.toThrow(
      "Another meeting on Junior's calendar uses this Meet link",
    );
    expect(copiedLink.fetch).toHaveBeenCalledTimes(2);
    const calendarList = new URL(
      copiedLink.fetch.mock.calls[1]![0].request.url,
    );
    expect(calendarList.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(calendarList.searchParams.get("timeMin")).toBe(
      "2026-10-05T17:00:00.000Z",
    );

    const { fetch, read } = meetTools(
      Response.json(event),
      Response.json({
        items: [
          event,
          // Other meetings, and cancelled copies of the link, do not block.
          {
            ...event,
            hangoutLink: undefined,
            conferenceData: undefined,
            attendees: [],
            id: "standup",
          },
          { ...event, attendees: [], id: "old", status: "cancelled" },
        ],
      }),
      Response.json({
        conferenceRecords: [
          {
            endTime: "2026-10-12T17:31:00Z",
            name: "conferenceRecords/conf1",
            startTime: "2026-10-12T16:58:00Z",
          },
        ],
      }),
      Response.json({
        transcripts: [
          { name: "conferenceRecords/conf1/transcripts/t1", state: "ENDED" },
        ],
      }),
      Response.json({
        participants: [
          {
            name: "conferenceRecords/conf1/participants/p1",
            signedinUser: { displayName: "Bob" },
          },
        ],
      }),
      Response.json({
        nextPageToken: "page-2",
        transcriptEntries: [
          {
            participant: "conferenceRecords/conf1/participants/p1",
            startTime: "2026-10-12T17:01:00Z",
            text: "Junior, add this context to the ticket.",
          },
        ],
      }),
      Response.json({
        transcriptEntries: [
          {
            participant: "conferenceRecords/conf1/participants/p9",
            text: "Sounds good.",
          },
        ],
      }),
    );

    const result = await read("event1");

    const records = new URL(fetch.mock.calls[2]![0].request.url);
    expect(records.origin + records.pathname).toBe(
      "https://meet.googleapis.com/v2/conferenceRecords",
    );
    // Only calls of this occurrence of this meeting.
    expect(records.searchParams.get("filter")).toBe(
      'space.meeting_code = "abc-defg-hij" AND start_time >= "2026-10-12T16:00:00.000Z" AND start_time <= "2026-10-12T17:30:00.000Z"',
    );
    expect(
      new URL(fetch.mock.calls[6]![0].request.url).searchParams.get(
        "pageToken",
      ),
    ).toBe("page-2");
    expect(
      fetch.mock.calls.every(
        ([call]) => (call as { request: Request }).request.method === "GET",
      ),
    ).toBe(true);
    expect(result).toEqual({
      eventId: "event1",
      meetingCode: "abc-defg-hij",
      status: "ok",
      target: "readMeetingTranscript",
      title: "Weekly triage",
      transcripts: [
        {
          conferenceEndTime: "2026-10-12T17:31:00Z",
          conferenceStartTime: "2026-10-12T16:58:00Z",
          entries: [
            {
              speaker: "Bob",
              startTime: "2026-10-12T17:01:00Z",
              text: "Junior, add this context to the ticket.",
            },
            { speaker: "Unknown speaker", text: "Sounds good." },
          ],
          state: "ENDED",
        },
      ],
      truncated: false,
    });
  });

  it("reports when Google denies Meet access instead of failing", async () => {
    const denied = meetTools(
      Response.json(event),
      Response.json({ items: [event] }),
      Response.json(
        { error: { code: 403, status: "PERMISSION_DENIED" } },
        { status: 403 },
      ),
    );
    expect(await denied.read("event1")).toMatchObject({
      message: expect.stringContaining("people who joined the call"),
      status: "access_denied",
      transcripts: [],
    });

    const oldGrant = meetTools(
      Response.json(event),
      Response.json({ items: [event] }),
      Response.json(
        {
          error: {
            code: 403,
            details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
          },
        },
        { status: 403 },
      ),
    );
    expect(await oldGrant.read("event1")).toMatchObject({
      message: expect.stringContaining("connect it again"),
      status: "access_denied",
    });
  });
});
