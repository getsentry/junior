import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { ACCOUNT_EMAIL, stubGoogleEnv } from "./fixture";

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const REQUESTER = "alice@example.com";

function docsTools(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return { fetch, tools: toolsWith(fetch, REQUESTER) };
}

function toolsWith(fetch: ReturnType<typeof vi.fn>, email?: string) {
  return googlePlugin().hooks!.tools!({
    egress: { fetch },
    users: {
      resolveActor: async () => (email ? { user: { email } } : undefined),
      resolveTimezone: async () => "America/Los_Angeles",
    },
  } as never);
}

/** Drive file metadata, as Junior's account sees a file it can share. */
function driveFile(id: string, mimeType: string, name: string) {
  return Response.json({
    capabilities: { canShare: true },
    id,
    mimeType,
    name,
  });
}

/** A Drive permission list. */
function permissions(...items: Record<string, string>[]) {
  return Response.json({ permissions: items });
}

const requesterCanOpen = () =>
  permissions({ emailAddress: "Alice@Example.com", type: "user" });

/** Slides API text with one run. */
function slidesText(content: string) {
  return { textElements: [{ textRun: { content } }] };
}

/** One Slides text box. */
function textBox(content: string, objectId?: string) {
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Slides API field.
  return { objectId, shape: { text: slidesText(content) } };
}

function run(
  tools: ReturnType<typeof docsTools>["tools"],
  name: string,
  input: Record<string, unknown>,
) {
  const tool = tools[name]!;
  return tool.execute!(tool.prepareArguments!(input), { toolCallId: name });
}

describe("Google Docs, Sheets, and Slides tools", () => {
  beforeEach(() => stubGoogleEnv());
  afterEach(() => vi.unstubAllEnvs());

  it("finds a Doc, reads it from a shared link, and lists its comments", async () => {
    const { fetch, tools } = docsTools(
      Response.json({
        files: [
          {
            id: DOC_ID,
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-10-01T10:00:00Z",
            name: "Q4 plan",
            webViewLink: `https://docs.google.com/document/d/${DOC_ID}/edit`,
          },
        ],
        nextPageToken: "more",
      }),
      driveFile(DOC_ID, "application/vnd.google-apps.document", "Q4 plan"),
      requesterCanOpen(),
      new Response("# Q4 plan\n\nShip it.", {
        headers: { "content-type": "text/markdown" },
      }),
      driveFile(DOC_ID, "application/vnd.google-apps.document", "Q4 plan"),
      requesterCanOpen(),
      Response.json({
        comments: [
          {
            author: { displayName: "Bob" },
            content: "Which quarter?",
            id: "c1",
            quotedFileContent: { value: "Ship it." },
            replies: [
              { author: { displayName: "Alice" }, content: "Q4." },
              {
                action: "resolve",
                author: { displayName: "Bob" },
                content: "",
              },
            ],
            resolved: true,
          },
        ],
        nextPageToken: "page-2",
      }),
    );

    const search = await run(tools, "searchGoogleFiles", {
      query: "Bob's plan",
      types: ["document"],
    });
    const searchUrl = new URL(fetch.mock.calls[0]![0].request.url);
    expect(searchUrl.pathname).toBe("/drive/v3/files");
    expect(searchUrl.searchParams.get("q")).toBe(
      "(mimeType = 'application/vnd.google-apps.document') and trashed = false and fullText contains 'Bob\\'s plan' and (visibility != 'limited' or 'alice@example.com' in readers or 'alice@example.com' in writers or 'alice@example.com' in owners)",
    );
    expect(search).toMatchObject({
      files: [{ file_id: DOC_ID, title: "Q4 plan", type: "document" }],
      truncated: true,
    });

    const link = `https://docs.google.com/document/d/${DOC_ID}/edit?resourcekey=0-key`;
    const doc = await run(tools, "readGoogleDoc", { document: link });
    const [get, listed, exported] = fetch.mock.calls
      .slice(1, 4)
      .map(([call]) => call);
    expect(get.operation).toBe("google.drive.file.get");
    expect(listed.operation).toBe("google.drive.permissions.list");
    expect(exported.operation).toBe("google.drive.file.export");
    expect(new URL(exported.request.url).pathname).toBe(
      `/drive/v3/files/${DOC_ID}/export`,
    );
    // Google needs the resource key of an older Doc shared by link.
    for (const call of [get, listed, exported]) {
      expect(call.request.headers.get("X-Goog-Drive-Resource-Keys")).toBe(
        `${DOC_ID}/0-key`,
      );
    }
    expect(doc).toMatchObject({
      content: "# Q4 plan\n\nShip it.",
      document_id: DOC_ID,
      title: "Q4 plan",
      truncated: false,
    });

    const comments = await run(tools, "listGoogleFileComments", {
      file: DOC_ID,
    });
    expect(fetch.mock.calls.slice(4).map(([call]) => call.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.permissions.list",
      "google.drive.comments.list",
    ]);
    expect(comments).toEqual({
      target: "listGoogleFileComments",
      comments: [
        {
          author: "Bob",
          comment_id: "c1",
          content: "Which quarter?",
          quoted_text: "Ship it.",
          replies: [
            { author: "Alice", content: "Q4." },
            { action: "resolve", author: "Bob", content: "" },
          ],
          resolved: true,
        },
      ],
      file_id: DOC_ID,
      next_page_token: "page-2",
    });
  });

  it("explains a file Junior cannot open, a file of the wrong type, and a grant without Drive access", async () => {
    const { tools } = docsTools(
      Response.json({ error: { message: "File not found" } }, { status: 404 }),
      Response.json({
        id: DOC_ID,
        mimeType: "application/vnd.google-apps.spreadsheet",
        name: "Budget",
      }),
      Response.json(
        {
          error: {
            details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
            message: "Request had insufficient authentication scopes.",
          },
        },
        { status: 403 },
      ),
    );

    const hidden = run(tools, "readGoogleDoc", { document: DOC_ID });
    await expect(hidden).rejects.toThrow(PluginToolInputError);
    await expect(hidden).rejects.toThrow(
      `Your Google account (${ACCOUNT_EMAIL}) cannot open this file`,
    );
    await expect(
      run(tools, "readGoogleDoc", { document: DOC_ID }),
    ).rejects.toThrow('"Budget" is not a Google Doc');
    await expect(
      run(tools, "readGoogleDoc", { document: DOC_ID }),
    ).rejects.toThrow("An admin must reconnect it");
  });

  it("reads a file only for a requester who can open it, even when your account can only view it", async () => {
    const DOC = "application/vnd.google-apps.document";
    const viewOnly = (name: string) =>
      Response.json({
        capabilities: { canShare: false },
        id: DOC_ID,
        mimeType: DOC,
        name,
      });
    const { fetch, tools } = docsTools(
      viewOnly("Company plan"),
      Response.json({ files: [{ id: DOC_ID }] }),
      new Response("Plan", { headers: { "content-type": "text/markdown" } }),
      viewOnly("Salaries"),
      Response.json({
        files: [{ id: "1OtherDocId0123" }],
        nextPageToken: "p2",
      }),
      Response.json({ files: [] }),
      driveFile(DOC_ID, DOC, "Board notes"),
      permissions({ emailAddress: "bob@example.com", type: "user" }),
      driveFile(DOC_ID, DOC, "Board notes"),
      Response.json({
        nextPageToken: "page-2",
        permissions: [{ emailAddress: "staff@example.com", type: "group" }],
      }),
      permissions({ emailAddress: "bob@example.com", type: "user" }),
    );

    // Drive search answers for a file that your account can only view.
    await expect(
      run(tools, "readGoogleDoc", { document: DOC_ID }),
    ).resolves.toMatchObject({ content: "Plan" });
    const searched = new URL(fetch.mock.calls[1]![0].request.url);
    expect(searched.searchParams.get("q")).toBe(
      `name = 'Company plan' and (visibility != 'limited' or '${REQUESTER}' in readers or '${REQUESTER}' in writers or '${REQUESTER}' in owners)`,
    );

    const refused = [
      `Google shows no access for ${REQUESTER} to "Salaries" through their own email, their domain, or a link.`,
      `${REQUESTER} cannot open "Board notes".`,
      "It is shared with a Google group, and group membership is not checked.",
    ];
    for (const message of refused) {
      const read = run(tools, "readGoogleDoc", { document: DOC_ID });
      await expect(read).rejects.toThrow(PluginToolInputError);
      await expect(read).rejects.toThrow(message);
    }
    await expect(
      run(toolsWith(vi.fn()), "searchGoogleFiles", { query: "plan" }),
    ).rejects.toThrow("The requester's email is unknown");
  });

  it("finds only files that the requester can open, and counts a domain share only in your own domain", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ files: [] }));
    await run(toolsWith(fetch, "bob@partner.com"), "searchGoogleFiles", {
      query: "plan",
      types: ["document"],
    });
    expect(
      new URL(fetch.mock.calls[0]![0].request.url).searchParams.get("q"),
    ).toBe(
      "(mimeType = 'application/vnd.google-apps.document') and trashed = false and fullText contains 'plan' and (visibility = 'anyoneCanFind' or visibility = 'anyoneWithLink' or 'bob@partner.com' in readers or 'bob@partner.com' in writers or 'bob@partner.com' in owners)",
    );
    // Search results need no check of their own.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads every tab of a Sheet as CSV, and the text and notes of each slide", async () => {
    const SHEET_ID = "1SheetIdAbCdEfGhIjKlMnOp";
    const SLIDES_ID = "1SlidesIdAbCdEfGhIjKlMn";
    const { fetch, tools } = docsTools(
      driveFile(SHEET_ID, "application/vnd.google-apps.spreadsheet", "Budget"),
      requesterCanOpen(),
      Response.json({
        sheets: [
          { properties: { sheetType: "GRID", title: "Q4" } },
          { properties: { sheetType: "OBJECT", title: "Chart" } },
          { properties: { sheetType: "GRID", title: "Bob's tab" } },
        ],
      }),
      Response.json({
        valueRanges: [
          {
            range: "Q4!A1:B2",
            values: [
              ["Item", "Cost"],
              ["Laptops, new", "$1,200"],
            ],
          },
          { range: "'Bob''s tab'!A1:A1", values: [['Say "hi"']] },
        ],
      }),
      driveFile(
        SLIDES_ID,
        "application/vnd.google-apps.presentation",
        "Kickoff",
      ),
      requesterCanOpen(),
      Response.json({
        slides: [
          {
            pageElements: [
              textBox("Kickoff\n"),
              {
                elementGroup: {
                  children: [
                    {
                      table: {
                        tableRows: [
                          {
                            tableCells: [
                              { text: slidesText("Q4") },
                              { text: slidesText("Ship\n") },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              { image: { contentUrl: "https://example.com/logo.png" } },
            ],
            slideProperties: {
              notesPage: {
                notesProperties: { speakerNotesObjectId: "notes" },
                pageElements: [
                  textBox("Not notes", "thumbnail"),
                  textBox("Say hello.\n", "notes"),
                ],
              },
            },
          },
          { pageElements: [] },
        ],
      }),
    );

    const sheet = await run(tools, "readGoogleSheet", {
      spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`,
    });
    const batchGet = new URL(fetch.mock.calls[3]![0].request.url);
    expect(batchGet.host).toBe("sheets.googleapis.com");
    expect(batchGet.searchParams.getAll("ranges")).toEqual([
      "'Q4'",
      "'Bob''s tab'",
    ]);
    expect(sheet).toMatchObject({
      ranges: [
        {
          content: 'Item,Cost\n"Laptops, new","$1,200"',
          range: "Q4!A1:B2",
          truncated: false,
        },
        {
          content: '"Say ""hi"""',
          range: "'Bob''s tab'!A1:A1",
          truncated: false,
        },
      ],
      spreadsheet_id: SHEET_ID,
      tabs: ["Q4", "Bob's tab"],
      title: "Budget",
      truncated: false,
    });

    const slides = await run(tools, "readGoogleSlides", {
      presentation: `https://docs.google.com/presentation/d/${SLIDES_ID}/edit`,
    });
    expect(new URL(fetch.mock.calls[6]![0].request.url).host).toBe(
      "slides.googleapis.com",
    );
    expect(slides).toMatchObject({
      presentation_id: SLIDES_ID,
      slide_count: 2,
      slides: [
        { notes: "Say hello.", slide_number: 1, text: "Kickoff\nQ4 | Ship" },
        { slide_number: 2, text: "" },
      ],
      title: "Kickoff",
      truncated: false,
    });
  });
});
