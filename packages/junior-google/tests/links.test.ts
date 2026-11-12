import {
  objectLinkFilterMatches,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { ACCOUNT_EMAIL, stubGoogleEnv } from "./fixture";

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;
const TITLE = "Private launch plan";

const DOC = {
  id: DOC_ID,
  mimeType: "application/vnd.google-apps.document",
  modifiedTime: "2026-10-01T10:00:00.000Z",
  name: TITLE,
  owners: [{ displayName: "Bob Example", emailAddress: "bob@example.com" }],
};

const NAMED =
  "('alice@example.com' in readers or 'alice@example.com' in writers or 'alice@example.com' in owners)";
const ANYONE = "visibility = 'anyoneWithLink'";
const DOMAIN = "visibility = 'domainWithLink'";

type DriveQuery = typeof NAMED | typeof ANYONE | typeof DOMAIN;

/**
 * Fake Google behind plugin egress. `file` is what Junior's account reads,
 * and `finds` lists the Drive queries that find the file.
 */
function fakeGoogle(input: {
  event?: unknown;
  file?: unknown;
  finds?: DriveQuery[];
}) {
  const queries: string[] = [];
  const fetch = vi.fn(async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    if (url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q") ?? "";
      queries.push(q);
      const found = (input.finds ?? []).some((terms) => q.includes(terms));
      return Response.json({ files: found ? [{ id: DOC_ID }] : [] });
    }
    const body = url.pathname.startsWith("/drive/") ? input.file : input.event;
    return body
      ? Response.json(body)
      : Response.json({ error: { message: "Not found" } }, { status: 404 });
  });
  return { fetch, queries };
}

function linkType(objectType: string): PluginObjectLinkDefinition {
  return googlePlugin().objectLinks!.find(
    (link) => link.objectType === objectType,
  )!;
}

function resolveAs(
  email: string,
  google: ReturnType<typeof fakeGoogle>,
  objectType: string,
  url: string,
) {
  return linkType(objectType).resolve(
    {
      egress: { fetch: google.fetch },
      viewer: { email, id: `test:${email}`, identities: [] },
    } as never,
    new URL(url),
  );
}

describe("Google link cards", () => {
  beforeEach(() => stubGoogleEnv());
  afterEach(() => vi.unstubAllEnvs());

  describe("Docs, Sheets, and Slides", () => {
    it("shows a file that names the viewer", async () => {
      const google = fakeGoogle({ file: DOC, finds: [NAMED] });

      await expect(
        resolveAs("alice@example.com", google, "document", DOC_URL),
      ).resolves.toEqual({
        kind: "object",
        objectType: "document",
        key: DOC_ID,
        label: TITLE,
        title: TITLE,
        url: DOC_URL,
        displayType: "Google Doc",
        sourceUpdatedAt: DOC.modifiedTime,
        facts: {
          type: "document",
          owner: "Bob Example",
          modifiedAt: DOC.modifiedTime,
        },
      });
      expect(google.queries).toContain(
        `name = '${TITLE}' and trashed = false and ${NAMED}`,
      );
    });

    it("reads a signed-in link that names the account", async () => {
      const url = `https://docs.google.com/document/u/1/d/${DOC_ID}/edit`;
      const link = linkType("document");

      expect(
        link.filters.some((filter) =>
          objectLinkFilterMatches(filter, new URL(url)),
        ),
      ).toBe(true);
      await expect(
        resolveAs(
          "alice@example.com",
          fakeGoogle({ file: DOC, finds: [NAMED] }),
          "document",
          url,
        ),
      ).resolves.toMatchObject({ key: DOC_ID, title: TITLE });
    });

    it("shows a file that anyone in the viewer's domain can open", async () => {
      const google = fakeGoogle({ file: DOC, finds: [DOMAIN] });

      await expect(
        resolveAs("alice@example.com", google, "document", DOC_URL),
      ).resolves.toMatchObject({ title: TITLE });
    });

    it("hides a file that the viewer cannot open", async () => {
      const google = fakeGoogle({ file: DOC });

      const card = await resolveAs(
        "alice@example.com",
        google,
        "document",
        DOC_URL,
      );

      expect(card).toBeUndefined();
      expect(JSON.stringify(card ?? null)).not.toContain(TITLE);
    });

    it("hides a domain file from a viewer outside its domain", async () => {
      const google = fakeGoogle({ file: DOC, finds: [DOMAIN] });

      await expect(
        resolveAs("mallory@other.example", google, "document", DOC_URL),
      ).resolves.toBeUndefined();
      // Junior does not ask Drive about the domain share at all.
      expect(google.queries.some((q) => q.includes(DOMAIN))).toBe(false);
    });

    it("hides a file shared only with a group", async () => {
      // Drive matches `in readers` only for the group email, not for its
      // members.
      const google = fakeGoogle({
        file: DOC,
        finds: [
          "('eng@example.com' in readers or 'eng@example.com' in writers or 'eng@example.com' in owners)" as DriveQuery,
        ],
      });

      await expect(
        resolveAs("alice@example.com", google, "document", DOC_URL),
      ).resolves.toBeUndefined();
    });

    it("hides a file that Junior's account cannot open, or of another type", async () => {
      await expect(
        resolveAs("alice@example.com", fakeGoogle({}), "document", DOC_URL),
      ).resolves.toBeUndefined();
      await expect(
        resolveAs(
          "alice@example.com",
          fakeGoogle({ file: DOC, finds: [NAMED] }),
          "document",
          `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("Calendar events", () => {
    const eid = (calendar: string) =>
      Buffer.from(`evt123abc ${calendar}`).toString("base64");
    const EVENT_URL = `https://www.google.com/calendar/event?eid=${eid(ACCOUNT_EMAIL)}`;
    const EVENT = {
      attendees: [
        { displayName: "Alice", email: "alice@example.com" },
        { email: "bob@example.com" },
        { email: "room@resource.calendar.google.com", resource: true },
      ],
      creator: { email: ACCOUNT_EMAIL },
      end: {
        dateTime: "2026-10-05T17:30:00Z",
        timeZone: "America/Los_Angeles",
      },
      id: "evt123abc",
      organizer: { email: ACCOUNT_EMAIL },
      start: {
        dateTime: "2026-10-05T17:00:00Z",
        timeZone: "America/Los_Angeles",
      },
      summary: "Launch review",
      updated: "2026-10-01T10:00:00.000Z",
    };

    it("shows an event on Junior's calendar to an attendee", async () => {
      const google = fakeGoogle({ event: EVENT });

      const card = await resolveAs(
        "Alice@example.com",
        google,
        "calendar_event",
        EVENT_URL,
      );
      expect(card).toEqual({
        kind: "object",
        objectType: "calendar_event",
        key: "evt123abc",
        label: "Launch review",
        title: "Launch review",
        url: EVENT_URL,
        sourceUpdatedAt: EVENT.updated,
        facts: {
          type: "calendar_event",
          when: "Mon, Oct 5, 10:00 – 10:30 PDT",
        },
      });
      // The guest list stays hidden.
      expect(JSON.stringify(card)).not.toContain("@example.com");
      expect(new URL(google.fetch.mock.calls[0]![0].request.url).pathname).toBe(
        "/calendar/v3/calendars/primary/events/evt123abc",
      );
    });

    it("shows an event that has a guest without an email", async () => {
      await expect(
        resolveAs(
          "alice@example.com",
          fakeGoogle({
            event: {
              ...EVENT,
              attendees: [{ displayName: "Room" }, ...EVENT.attendees],
            },
          }),
          "calendar_event",
          EVENT_URL,
        ),
      ).resolves.toMatchObject({ key: "evt123abc" });
    });

    it("shows the date of an all-day event", async () => {
      await expect(
        resolveAs(
          "alice@example.com",
          fakeGoogle({
            event: {
              ...EVENT,
              start: { date: "2026-10-05" },
              end: { date: "2026-10-06" },
            },
          }),
          "calendar_event",
          EVENT_URL,
        ),
      ).resolves.toMatchObject({
        facts: { type: "calendar_event", when: "Mon, Oct 5" },
      });
    });

    it("hides an event from a viewer who is not on it", async () => {
      const card = await resolveAs(
        "mallory@example.com",
        fakeGoogle({ event: EVENT }),
        "calendar_event",
        EVENT_URL,
      );

      expect(card).toBeUndefined();
    });

    it("does not read events on another calendar", async () => {
      const google = fakeGoogle({ event: EVENT });

      await expect(
        resolveAs(
          "alice@example.com",
          google,
          "calendar_event",
          `https://calendar.google.com/calendar/event?eid=${eid("alice@example.com")}`,
        ),
      ).resolves.toBeUndefined();
      expect(google.fetch).not.toHaveBeenCalled();
    });
  });
});
