import {
  OBJECT_SUMMARY_MAX_LENGTH,
  objectLinkFilterMatches,
  objectLinkFilterSpecificity,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { saveGoogleAccount } from "../src/store";
import {
  ACCOUNT_EMAIL,
  ADMIN_EMAIL,
  API_SCOPES,
  createGoogleDb,
  stubGoogleEnv,
} from "./fixture";

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

const DRIVE = "https://drive.google.com";

const PDF = {
  id: DOC_ID,
  mimeType: "application/pdf",
  modifiedTime: "2026-10-02T09:30:00.000Z",
  name: "Q3 metrics.pdf",
  owners: [{ displayName: "Bob Example", emailAddress: "bob@example.com" }],
  thumbnailLink: "https://lh3.googleusercontent.com/drive-storage/thumb=s220",
};

const FOLDER = {
  id: DOC_ID,
  mimeType: "application/vnd.google-apps.folder",
  modifiedTime: "2026-10-03T08:00:00.000Z",
  name: "Launch assets",
  owners: [{ displayName: "Bob Example", emailAddress: "bob@example.com" }],
};

const EXCERPT = "Ship the launch on Monday after the security review.";

// What the Docs API returns for the Doc: a title, a heading, then the body.
const DOC_BODY = {
  body: {
    content: [
      { sectionBreak: {} },
      {
        paragraph: {
          elements: [{ textRun: { content: `${TITLE}\n` } }],
          paragraphStyle: { namedStyleType: "TITLE" },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: "Goals\n" } }],
          paragraphStyle: { namedStyleType: "HEADING_1" },
        },
      },
      {
        paragraph: {
          elements: [
            { textRun: { content: "Ship the launch on Monday " } },
            { textRun: { content: "after the security review.\n" } },
          ],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      },
    ],
  },
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
  doc?: unknown;
  docFails?: boolean;
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
    if (input.docFails && url.pathname.startsWith("/v1/documents/")) {
      throw new TypeError("fetch failed");
    }
    const body = url.pathname.startsWith("/drive/")
      ? input.file
      : url.pathname.startsWith("/v1/documents/")
        ? input.doc
        : input.event;
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
      imagePath: (ref: string, version?: string) =>
        `/api/images/${Buffer.from(ref).toString("base64url")}.sig?w=640${version ? `&v=${version}` : ""}`,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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

    it("shows the first body paragraph of a Doc that the viewer can open", async () => {
      const google = fakeGoogle({ doc: DOC_BODY, file: DOC, finds: [NAMED] });

      await expect(
        resolveAs("alice@example.com", google, "document", DOC_URL),
      ).resolves.toMatchObject({
        facts: { type: "document", summary: EXCERPT },
      });
    });

    it("still shows a Doc when its summary cannot be read", async () => {
      const google = fakeGoogle({
        doc: DOC_BODY,
        docFails: true,
        file: DOC,
        finds: [NAMED],
      });

      const card = await resolveAs(
        "alice@example.com",
        google,
        "document",
        DOC_URL,
      );

      expect(card).toMatchObject({ key: DOC_ID, title: TITLE });
      expect(card?.facts?.summary).toBeUndefined();
    });

    it("cuts a long first paragraph at a word", async () => {
      const long = `${"Launch detail ".repeat(40)}end`;
      const google = fakeGoogle({
        doc: {
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: long } }] } },
            ],
          },
        },
        file: DOC,
        finds: [NAMED],
      });

      const card = await resolveAs(
        "alice@example.com",
        google,
        "document",
        DOC_URL,
      );
      const summary = card?.facts?.summary ?? "";

      expect(summary.length).toBeLessThanOrEqual(OBJECT_SUMMARY_MAX_LENGTH);
      expect(summary).toMatch(/^Launch detail .* detail…$/);
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
      const google = fakeGoogle({ doc: DOC_BODY, file: DOC });

      const card = await resolveAs(
        "alice@example.com",
        google,
        "document",
        DOC_URL,
      );

      expect(card).toBeUndefined();
      expect(JSON.stringify(card ?? null)).not.toContain(TITLE);
      // The Doc text is not read before the viewer is allowed.
      expect(
        google.fetch.mock.calls.some(([{ request }]) =>
          request.url.includes("/v1/documents/"),
        ),
      ).toBe(false);
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

    it("names the tool that reads an attached file live", async () => {
      const readTool = async (file: unknown, url: string) => {
        const card = await resolveAs(
          "alice@example.com",
          fakeGoogle({ file, finds: [NAMED] }),
          "document",
          url,
        );
        return linkType("document").readTool?.(card!);
      };
      // readGoogleFile reads a Doc, Sheet, or Slides file from any link.
      expect(await readTool(DOC, DOC_URL)).toBe("readGoogleFile");
      expect(await readTool(DOC, `${DRIVE}/file/d/${DOC_ID}/view`)).toBe(
        "readGoogleFile",
      );
      // No tool reads another Drive file or a Calendar event.
      expect(await readTool(PDF, `${DRIVE}/file/d/${DOC_ID}/view`)).toBe(
        undefined,
      );
      expect(linkType("calendar_event").readTool).toBeUndefined();
    });
  });

  describe("Drive files and folders", () => {
    const pdfCard = {
      kind: "object",
      objectType: "document",
      key: DOC_ID,
      label: "Q3 metrics.pdf",
      title: "Q3 metrics.pdf",
      url: `${DRIVE}/file/d/${DOC_ID}/view`,
      displayType: "PDF",
      sourceUpdatedAt: PDF.modifiedTime,
      facts: {
        type: "document",
        owner: "Bob Example",
        modifiedAt: PDF.modifiedTime,
        thumbnailUrl: `/api/images/${Buffer.from(DOC_ID).toString("base64url")}.sig?w=640&v=${Date.parse(PDF.modifiedTime)}`,
      },
    };

    it("claims every Drive link form ahead of the web page card", () => {
      // Core's catch-all web page card matches any https link with no host,
      // so a matching filter with a host wins over it.
      const [webPageHostRank = 0] = objectLinkFilterSpecificity({
        scheme: "https",
      });
      for (const url of [
        `${DRIVE}/file/d/${DOC_ID}/view`,
        `${DRIVE}/file/u/1/d/${DOC_ID}/view`,
        `${DRIVE}/open?id=${DOC_ID}`,
        `${DRIVE}/drive/folders/${DOC_ID}`,
        `${DRIVE}/drive/u/0/folders/${DOC_ID}`,
        `${DRIVE}/drive/u/0/my-drive`,
      ]) {
        const hostRanks = linkType("document")
          .filters.filter((filter) =>
            objectLinkFilterMatches(filter, new URL(url)),
          )
          .map((filter) => objectLinkFilterSpecificity(filter)[0] ?? 0);
        expect(Math.max(-1, ...hostRanks)).toBeGreaterThan(webPageHostRank);
      }
    });

    it("shows a Drive link to a Doc as the same card as its Docs link", async () => {
      const resolveDoc = (url: string) =>
        resolveAs(
          "alice@example.com",
          fakeGoogle({ doc: DOC_BODY, file: DOC, finds: [NAMED] }),
          "document",
          url,
        );
      const docs = await resolveDoc(DOC_URL);
      for (const url of [
        `${DRIVE}/file/d/${DOC_ID}/view?usp=sharing`,
        `${DRIVE}/open?id=${DOC_ID}`,
      ]) {
        expect(await resolveDoc(url)).toEqual({ ...docs, url });
      }
      expect(docs).toMatchObject({
        displayType: "Google Doc",
        facts: { summary: EXCERPT },
      });
    });

    it("shows a PDF with a thumbnail from the image proxy", async () => {
      for (const url of [
        `${DRIVE}/file/d/${DOC_ID}/view`,
        `${DRIVE}/file/u/1/d/${DOC_ID}/view`,
        `${DRIVE}/open?id=${DOC_ID}`,
      ]) {
        const card = await resolveAs(
          "alice@example.com",
          fakeGoogle({ file: PDF, finds: [NAMED] }),
          "document",
          url,
        );
        expect(card).toEqual({ ...pdfCard, url });
        // The card names a Junior image path, never Google's link.
        expect(JSON.stringify(card)).not.toContain("googleusercontent");
      }
    });

    it("shows a folder without a thumbnail", async () => {
      for (const url of [
        `${DRIVE}/drive/folders/${DOC_ID}`,
        `${DRIVE}/drive/u/0/folders/${DOC_ID}?usp=sharing`,
        `${DRIVE}/open?id=${DOC_ID}`,
      ]) {
        await expect(
          resolveAs(
            "alice@example.com",
            fakeGoogle({ file: FOLDER, finds: [ANYONE] }),
            "document",
            url,
          ),
        ).resolves.toEqual({
          kind: "object",
          objectType: "document",
          key: DOC_ID,
          label: "Launch assets",
          title: "Launch assets",
          url,
          displayType: "Google Drive folder",
          sourceUpdatedAt: FOLDER.modifiedTime,
          facts: {
            type: "document",
            owner: "Bob Example",
            modifiedAt: FOLDER.modifiedTime,
          },
        });
      }
    });

    it("hides a Drive link that does not fit the file", async () => {
      for (const [file, url] of [
        [FOLDER, `${DRIVE}/file/d/${DOC_ID}/view`],
        [PDF, `${DRIVE}/drive/folders/${DOC_ID}`],
        [{ ...PDF, trashed: true }, `${DRIVE}/file/d/${DOC_ID}/view`],
        [
          { ...PDF, mimeType: "application/vnd.google-apps.shortcut" },
          `${DRIVE}/open?id=${DOC_ID}`,
        ],
        [PDF, `${DRIVE}/drive/u/0/my-drive`],
      ] as const) {
        await expect(
          resolveAs(
            "alice@example.com",
            fakeGoogle({ file, finds: [NAMED] }),
            "document",
            url,
          ),
        ).resolves.toBeUndefined();
      }
    });

    it("hides a Drive file shared only with a group", async () => {
      // A group share names no viewer, so no Drive query finds the file.
      await expect(
        resolveAs(
          "alice@example.com",
          fakeGoogle({ file: PDF, finds: [] }),
          "document",
          `${DRIVE}/file/d/${DOC_ID}/view`,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("Drive thumbnails", () => {
    let fixture: Awaited<ReturnType<typeof createGoogleDb>>;
    beforeEach(async () => {
      fixture = await createGoogleDb();
      await saveGoogleAccount(fixture.db(), {
        accountEmail: ACCOUNT_EMAIL,
        connectedAtMs: Date.now(),
        connectedBy: ADMIN_EMAIL,
        refreshToken: "refresh-token",
        scope: API_SCOPES,
      });
    });
    afterEach(async () => {
      vi.unstubAllGlobals();
      await fixture.close();
    });

    function readThumbnail(
      email: string,
      google: ReturnType<typeof fakeGoogle>,
      ref = DOC_ID,
    ) {
      // The token refresh is the only global fetch.
      const tokenFetch = vi.fn(async () =>
        Response.json({ access_token: "access-token", expires_in: 3600 }),
      );
      vi.stubGlobal("fetch", tokenFetch);
      const result = googlePlugin().images!.resolve(
        {
          db: fixture.db(),
          egress: { fetch: google.fetch },
          log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
          viewer: { email, id: `test:${email}`, identities: [] },
        } as never,
        ref,
      );
      return { result, tokenFetch };
    }

    it("sends Junior's credential only to Google's thumbnail host", async () => {
      const { result, tokenFetch } = readThumbnail(
        "alice@example.com",
        fakeGoogle({ file: PDF, finds: [NAMED] }),
      );
      await expect(result).resolves.toEqual({
        headers: { authorization: "Bearer access-token" },
        url: "https://lh3.googleusercontent.com/drive-storage/thumb=s640",
      });
      expect(tokenFetch).toHaveBeenCalledOnce();
    });

    it("serves no thumbnail and reads no token for a denied viewer", async () => {
      for (const google of [
        fakeGoogle({ file: PDF, finds: [] }),
        fakeGoogle({ file: { ...PDF, trashed: true }, finds: [NAMED] }),
        fakeGoogle({ file: FOLDER, finds: [NAMED] }),
        fakeGoogle({
          file: { ...PDF, thumbnailLink: "https://evil.example.com/t=s220" },
          finds: [NAMED],
        }),
        fakeGoogle({}),
      ]) {
        const { result, tokenFetch } = readThumbnail(
          "alice@example.com",
          google,
        );
        await expect(result).resolves.toBeUndefined();
        expect(tokenFetch).not.toHaveBeenCalled();
      }
      const { result } = readThumbnail(
        "alice@example.com",
        fakeGoogle({ file: PDF, finds: [NAMED] }),
        "../other",
      );
      await expect(result).resolves.toBeUndefined();
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
      description:
        "<p>Decide <b>go/no-go</b> for 4.2.</p><p>Bring the risk list &amp; notes.</p>",
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
          summary: "Decide go/no-go for 4.2. Bring the risk list & notes.",
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

    it("shows the event's offset time when it has no time zone", async () => {
      await expect(
        resolveAs(
          "alice@example.com",
          fakeGoogle({
            event: {
              ...EVENT,
              start: { dateTime: "2026-10-05T10:00:00-07:00" },
              end: { dateTime: "2026-10-05T10:30:00-07:00" },
            },
          }),
          "calendar_event",
          EVENT_URL,
        ),
      ).resolves.toMatchObject({
        facts: { when: "Mon, Oct 5, 10:00 – 10:30 GMT-7" },
      });
    });

    it("reads an eid that has a base64 plus sign", async () => {
      // This address makes the eid `ZXZ0MTIzYWJjIGp+bmlvckBleGFtcGxlLmNvbQ==`.
      vi.stubEnv("GOOGLE_WORKSPACE_ACCOUNT_EMAIL", "j~nior@example.com");
      const url = `https://www.google.com/calendar/event?eid=${eid("j~nior@example.com")}`;
      expect(url).toContain("+");

      await expect(
        resolveAs(
          "alice@example.com",
          fakeGoogle({ event: EVENT }),
          "calendar_event",
          url,
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
      expect(JSON.stringify(card ?? null)).not.toContain("risk list");
    });

    it("cuts a long description at a word", async () => {
      const card = await resolveAs(
        "alice@example.com",
        fakeGoogle({
          event: {
            ...EVENT,
            description: `<ul>${"<li>Check rollout</li>".repeat(40)}</ul>`,
          },
        }),
        "calendar_event",
        EVENT_URL,
      );
      const summary = card?.facts?.summary ?? "";

      expect(summary.length).toBeLessThanOrEqual(OBJECT_SUMMARY_MAX_LENGTH);
      expect(summary).toMatch(/^Check rollout Check .*…$/);
      expect(summary).not.toContain("<");
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
