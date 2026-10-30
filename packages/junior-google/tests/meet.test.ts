import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { ACCOUNT_EMAIL, stubGoogleEnv } from "./fixture";

const REQUESTER = "alice@example.com";
const DOC = "application/vnd.google-apps.document";
const NOTES_ID = "1NotesAbCdEfGhIjKlMnOpQr";
const FORGED_ID = "1ForgedAbCdEfGhIjKlMnOpQ";
const DELETED_ID = "1DeletedAbCdEfGhIjKlMnOp";
const AGENDA_ID = "1AgendaAbCdEfGhIjKlMnOp";
const LONG_NOTES = `# Notes\n\n${"**Bob:** Next topic.\n".repeat(6_000)}`;
const NOTES_TITLE = "Weekly triage - 2026/10/12 10:01 PDT - Notes by Gemini";

function meetTools(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const sandbox = {
    root: "/vercel/sandbox",
    run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    writeFile: vi.fn(),
  };
  const tools = googlePlugin().hooks!.tools!({
    egress: { fetch },
    sandbox,
    users: {
      resolveActor: async () => ({
        user: { email: REQUESTER, id: "user-1", identities: [] },
      }),
      resolveTimezone: async () => "America/Los_Angeles",
    },
  } as never);
  const run = (name: string, input: Record<string, unknown>) =>
    tools[name]!.execute!(tools[name]!.prepareArguments!(input), {
      toolCallId: "call-1",
    });
  return { fetch, run, sandbox };
}

// Bob organizes the meeting and invited Junior and Alice.
const event = {
  attachments: [
    { fileId: NOTES_ID, mimeType: DOC, title: NOTES_TITLE },
    // Anyone who can edit the event can attach a Doc with a record title.
    {
      fileId: FORGED_ID,
      mimeType: DOC,
      title: "Board - 2026/10/12 10:01 PDT - Transcript",
    },
    { fileId: AGENDA_ID, mimeType: DOC, title: "Agenda" },
  ],
  attendees: [
    { email: "bob@example.com", responseStatus: "accepted" },
    { email: "Alice@example.com", responseStatus: "accepted" },
    { email: ACCOUNT_EMAIL, responseStatus: "needsAction", self: true },
  ],
  end: { dateTime: "2026-10-12T10:30:00-07:00" },
  id: "event1",
  organizer: { email: "bob@example.com" },
  start: { dateTime: "2026-10-12T10:00:00-07:00" },
  summary: "Weekly triage",
};

describe("Google Meet transcripts", () => {
  beforeEach(() => stubGoogleEnv());
  afterEach(() => vi.unstubAllEnvs());

  it("reads Meet records only for meetings where Junior and the requester are invited", async () => {
    const outsider = meetTools(
      Response.json({
        ...event,
        attendees: [{ email: "bob@example.com" }, event.attendees[2]],
      }),
    );
    await expect(
      outsider.run("readMeetingTranscript", { eventId: "event1" }),
    ).rejects.toBeInstanceOf(PluginToolInputError);
    const notInvited = meetTools(
      Response.json({ ...event, attendees: event.attendees.slice(0, 2) }),
    );
    await expect(
      notInvited.run("readMeetingTranscript", { eventId: "event1" }),
    ).rejects.toThrow("You are not invited");
    // A cancelled event can be a stub without times or attendees.
    const cancelled = meetTools(
      Response.json({ id: "event1", status: "cancelled" }),
    );
    await expect(
      cancelled.run("readMeetingTranscript", { eventId: "event1" }),
    ).rejects.toThrow("was cancelled");
    // None of them reached Drive.
    for (const { fetch } of [outsider, notInvited, cancelled]) {
      expect(fetch).toHaveBeenCalledTimes(1);
    }

    const { fetch, run } = meetTools(
      Response.json(event),
      Response.json({
        createdTime: "2026-10-12T17:31:00Z",
        id: NOTES_ID,
        mimeType: DOC,
        name: NOTES_TITLE,
        owners: [{ emailAddress: "Bob@example.com" }],
        webViewLink: `https://docs.google.com/document/d/${NOTES_ID}/edit`,
      }),
      new Response("# Notes\n\n**Bob:** Junior, add this to the ticket.", {
        headers: { "content-type": "text/markdown" },
      }),
      // The forged record belongs to someone else, so Junior does not read it.
      Response.json({
        createdTime: "2026-10-12T17:31:00Z",
        id: FORGED_ID,
        mimeType: DOC,
        name: "Board - 2026/10/12 10:01 PDT - Transcript",
        owners: [{ emailAddress: "carol@example.com" }],
      }),
      // The organizer made the agenda before the meeting, so it is not a
      // record of this meeting.
      Response.json({
        createdTime: "2026-10-05T09:00:00Z",
        id: AGENDA_ID,
        mimeType: DOC,
        name: "Agenda",
        owners: [{ emailAddress: "bob@example.com" }],
      }),
    );

    const result = await run("readMeetingTranscript", { eventId: "event1" });

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(
      fetch.mock.calls.map(([call]) => new URL(call.request.url).pathname),
    ).toEqual([
      "/calendar/v3/calendars/primary/events/event1",
      `/drive/v3/files/${NOTES_ID}`,
      `/drive/v3/files/${NOTES_ID}/export`,
      `/drive/v3/files/${FORGED_ID}`,
      `/drive/v3/files/${AGENDA_ID}`,
    ]);
    expect(result).toEqual({
      eventId: "event1",
      records: [
        {
          content: "# Notes\n\n**Bob:** Junior, add this to the ticket.",
          kind: "notes",
          title: NOTES_TITLE,
          url: `https://docs.google.com/document/d/${NOTES_ID}/edit`,
        },
      ],
      status: "ok",
      target: "readMeetingTranscript",
      title: "Weekly triage",
      truncated: false,
    });

    const early = meetTools(Response.json({ ...event, attachments: [] }));
    expect(
      await early.run("readMeetingTranscript", { eventId: "event1" }),
    ).toMatchObject({
      message: expect.stringContaining("turn on transcription"),
      records: [],
      status: "no_record",
    });

    // An all-day event has only a date. A record that Junior cannot open does
    // not hide the other records. A record title in another language is
    // still read. A long record is saved in full to the sandbox.
    const allDay = meetTools(
      Response.json({
        ...event,
        attachments: [
          { fileId: DELETED_ID, mimeType: DOC, title: NOTES_TITLE },
          event.attachments[0],
        ],
        end: { date: "2026-10-13" },
        start: { date: "2026-10-12" },
      }),
      Response.json({ error: { code: 404 } }, { status: 404 }),
      Response.json({
        createdTime: "2026-10-12T17:31:00Z",
        id: NOTES_ID,
        mimeType: DOC,
        name: "Weekly triage - 12.10.2026 - Notizen von Gemini",
        owners: [{ emailAddress: "bob@example.com" }],
      }),
      new Response(LONG_NOTES, {
        headers: { "content-type": "text/markdown" },
      }),
    );
    expect(
      await allDay.run("readMeetingTranscript", { eventId: "event1" }),
    ).toMatchObject({
      message: expect.stringContaining("cannot be opened"),
      records: [
        {
          content: LONG_NOTES.slice(0, 100_000),
          kind: "document",
          path: `/vercel/sandbox/meetings/event1/${NOTES_ID}.md`,
        },
      ],
      status: "ok",
      truncated: true,
    });
    expect(allDay.sandbox.writeFile).toHaveBeenCalledWith({
      content: LONG_NOTES,
      path: `/vercel/sandbox/meetings/event1/${NOTES_ID}.md`,
    });
  });
});
