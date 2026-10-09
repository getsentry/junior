import { describe, expect } from "vitest";
import {
  connectGoogleAccount,
  mockGoogleCalendars,
} from "@junior-evals/fixture/google";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const REQUESTER_EMAIL = "testuser@example.com";
const SAM_EMAIL = "sam@example.com";
// Junior's account cannot see this calendar.
const RILEY_EMAIL = "riley@example.com";

/** The requester and Sam each have one meeting on every weekday morning. */
function mockTeamCalendars() {
  mockGoogleCalendars([
    {
      email: REQUESTER_EMAIL,
      events: [
        {
          end: "10:00",
          start: "09:00",
          title: "Focus time",
          weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        },
      ],
    },
    {
      email: SAM_EMAIL,
      events: [
        {
          end: "12:00",
          start: "10:00",
          title: "Roadmap planning",
          weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        },
      ],
    },
  ]);
}

/** The Pacific weekday and 24-hour clock time of an RFC 3339 time. */
function pacific(time: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
      weekday: "short",
    })
      .formatToParts(Date.parse(time))
      .map((part) => [part.type, part.value]),
  );
  return { clock: `${parts.hour}:${parts.minute}`, weekday: parts.weekday };
}

describe("Google Calendar", () => {
  test("when asked to find a time with colleagues, check everyone's free/busy without asking and say whose calendar it could not check", async ({
    run,
  }) => {
    await connectGoogleAccount();
    mockTeamCalendars();

    const conversation = await run(
      slackMention(
        `find 30 minutes for me, ${SAM_EMAIL} and ${RILEY_EMAIL} in the next few days`,
      ),
    );

    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply offers at least one specific meeting time.",
          "The reply says that Riley's calendar could not be checked.",
        ],
        fail: [
          "Do not say or imply that Riley is free at the offered times.",
          "Do not ask the requester to confirm before checking calendars.",
        ],
      }),
    );

    const searches = completedToolCalls(
      "google_findMeetingTimes",
      conversation,
    ).map(toolOutput);
    // Junior adds the requester to the search.
    expect(searches).toContainEqual(
      expect.objectContaining({
        checked: expect.arrayContaining([
          expect.objectContaining({ email: REQUESTER_EMAIL }),
          expect.objectContaining({ email: SAM_EMAIL }),
        ]),
        slots: expect.arrayContaining([expect.anything()]),
        unavailable: [expect.objectContaining({ email: RILEY_EMAIL })],
      }),
    );
    expect(toolCallsOf("google_createCalendarEvent", conversation)).toEqual([]);
  });

  test("when asked what is on a colleague's calendar, read their shared events", async ({
    run,
  }) => {
    await connectGoogleAccount();
    mockTeamCalendars();

    const conversation = await run(
      slackMention(
        `what meetings does ${SAM_EMAIL} have on their calendar over the next week?`,
      ),
    );

    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply names Sam's Roadmap planning meetings."],
        fail: [
          "Do not say that Junior cannot see Sam's calendar.",
          "Do not ask the requester to confirm before reading the calendar.",
        ],
      }),
    );

    const reads = completedToolCalls("google_listCalendarEvents", conversation);
    expect(reads.map((call) => call.input)).toContainEqual(
      expect.objectContaining({ calendar: SAM_EMAIL }),
    );
  });

  test("when asked to book a meeting at a stated time, create one event and invite the requester and attendees", async ({
    run,
  }) => {
    await connectGoogleAccount();
    mockTeamCalendars();

    const conversation = await run(
      slackMention(
        `book a 30 minute meeting called "Stream prep" with ${SAM_EMAIL} next tuesday at 2pm pacific`,
      ),
    );

    const creates = completedToolCalls(
      "google_createCalendarEvent",
      conversation,
    );
    expect(creates).toHaveLength(1);
    const input = creates[0]!.input as {
      attendees: string[];
      end: string;
      start: string;
      title: string;
    };
    expect(input.title).toMatch(/stream prep/i);
    expect(input.attendees).toContain(SAM_EMAIL);
    expect(pacific(input.start)).toEqual({ clock: "14:00", weekday: "Tue" });
    expect(Date.parse(input.end) - Date.parse(input.start)).toBe(30 * 60_000);
    expect(toolOutput(creates[0]!)).toMatchObject({
      attendees: expect.arrayContaining([
        expect.objectContaining({ email: REQUESTER_EMAIL }),
        expect.objectContaining({ email: SAM_EMAIL }),
      ]),
      created: true,
    });
  });

  test("when Junior's Google account is not connected, say that an admin must connect it", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(`find 30 minutes for me and ${SAM_EMAIL} this week`),
    );

    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says that Junior's Google account is not connected and that a Junior admin must connect it.",
        ],
        fail: [
          "Do not offer meeting times as if calendars were checked.",
          "Do not tell the requester to connect their own Google account.",
        ],
      }),
    );

    expect(completedToolCalls("google_findMeetingTimes", conversation)).toEqual(
      [],
    );
  });
});
