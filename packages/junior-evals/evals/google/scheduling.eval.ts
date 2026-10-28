import { describe, expect } from "vitest";
import {
  connectGoogleAccount,
  mockGoogleCalendars,
} from "@junior-evals/fixture/google";
import {
  person,
  reply,
  slackMention,
  slackThreadMessage,
} from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test, type Conversation } from "@junior-evals/fixture/test";

const SAM = person("U0SAM", "Sam");
const REQUESTER_EMAIL = "testuser@example.com";
const SAM_EMAIL = "sam@example.com";

/**
 * The requester holds every weekday afternoon with "DNS" (do not schedule)
 * blocks. Free/busy shows them as busy, but they are holds, not meetings.
 * Sam has real meetings. On Wednesdays and Fridays, Sam's only afternoon gap
 * of 90 minutes or more is 1:30-3:30 PM PT, so the time must fit there.
 */
function mockTeamCalendars() {
  mockGoogleCalendars([
    {
      email: REQUESTER_EMAIL,
      events: [
        {
          end: "17:00",
          start: "12:00",
          title: "DNS",
          weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        },
      ],
    },
    {
      email: SAM_EMAIL,
      events: [
        {
          end: "13:30",
          start: "12:00",
          title: "Lunch + design review",
          weekdays: ["Wed"],
        },
        {
          end: "17:00",
          start: "15:30",
          title: "Team sync",
          weekdays: ["Wed", "Fri"],
        },
        {
          end: "13:30",
          start: "12:30",
          title: "Interview loop",
          weekdays: ["Fri"],
        },
      ],
    },
  ]);
}

/** The thread opens with Sam, so both people are in the conversation. */
const SAM_OPENS_THREAD = slackThreadMessage(
  "want to start streaming our pairing sessions? i'm in if we can find a regular slot",
  { author: SAM },
);

const FIRST_REQUEST =
  "i have a bunch of DNS schedule blocks in the afternoon, but we want to find a time wednesdays and fridays for like 90 minutes to optionally stream, probably in the afternoon, maybe early afternoon?";

/** Completed calendar reads that looked at Sam's calendar. */
function samCalendarChecks(conversation: Conversation) {
  const freeBusy = completedToolCalls(
    "google_findMeetingTimes",
    conversation,
  ).filter((call) =>
    ((call.input as { attendees?: string[] }).attendees ?? []).some(
      (email) => email.toLowerCase() === SAM_EMAIL,
    ),
  );
  const events = completedToolCalls(
    "google_listCalendarEvents",
    conversation,
  ).filter(
    (call) =>
      (call.input as { calendar?: string }).calendar?.toLowerCase() ===
      SAM_EMAIL,
  );
  return [...freeBusy, ...events];
}

const SCHEDULING_RUBRIC = rubric({
  pass: [
    "The reply proposes a concrete 90-minute time on Wednesdays and Fridays in the early afternoon Pacific time that works for both the requester and Sam, such as 1:30–3:00 PM PT.",
    "The proposed Wednesday time does not overlap Sam's Wednesday meetings from 12:00–1:30 PM PT and 3:30–5:00 PM PT, and the proposed Friday time does not overlap Sam's Friday meetings from 12:30–1:30 PM PT and 3:30–5:00 PM PT.",
    "The reply treats the requester's DNS blocks as holds that the requester can move, not as real conflicts.",
  ],
  fail: [
    "Do not report that there are no open times only because the requester's DNS blocks fill the afternoons.",
    "Do not ask the requester for permission or confirmation before a read-only calendar availability check.",
    "Do not ask who else must attend; Sam is in the thread.",
  ],
});

describe("Google Calendar Scheduling", () => {
  test("when a recurring slot is for two people and the requester's afternoons are holds, check both and propose a time", async ({
    run,
  }) => {
    await connectGoogleAccount();
    mockTeamCalendars();

    const conversation = await run(slackMention(FIRST_REQUEST), {
      history: [SAM_OPENS_THREAD],
    });

    await expect(conversation).toSatisfyJudge(RubricJudge, SCHEDULING_RUBRIC);
    expect(samCalendarChecks(conversation)).not.toHaveLength(0);
  });

  test("when the requester corrects a one-sided answer, check the other attendee without asking again", async ({
    run,
  }) => {
    await connectGoogleAccount();
    mockTeamCalendars();

    // Junior asked to confirm read-only checks, looked only at the
    // requester, and then proposed a time from the requester's stated hours.
    const conversation = await run(
      slackMention("then you better check dummy, its for me + sam"),
      {
        history: [
          SAM_OPENS_THREAD,
          slackMention(FIRST_REQUEST),
          reply(
            "Should I check your free/busy calendar for 90-minute slots from 12–5 p.m. PT on all weekdays for the next two weeks? That may surface times outside the Wednesdays and Fridays you mentioned; it's a read-only check.",
          ),
          slackMention(
            "yeah though i have some pto coming up the week after next, so its not representative",
          ),
          reply(
            "No 90-minute openings showed up from 12–5 p.m. PT on the next few Wednesdays and Fridays. Can I check your free/busy for one more Friday too? It's read-only and outside the window you approved.",
          ),
          slackMention(
            "my calendar has blocks so you wont see free times on any afternoon, but im generally free from 1-5pm",
          ),
          reply(
            "Got it—the DNS blocks are placeholders, not real conflicts. **1:30–3 p.m. PT** is a good 90-minute candidate on both Wednesdays and Fridays based on your usual availability. I can't confirm it works for the rest of the group without checking their calendars.",
          ),
        ],
      },
    );

    await expect(conversation).toSatisfyJudge(RubricJudge, SCHEDULING_RUBRIC);
    expect(samCalendarChecks(conversation)).not.toHaveLength(0);
  });
});
