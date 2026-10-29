import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { ACCOUNT_EMAIL, stubGoogleEnv } from "./fixture";

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

function docsTools(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const tools = googlePlugin().hooks!.tools!({
    egress: { fetch },
    users: {
      resolveActor: async () => undefined,
      resolveTimezone: async () => "America/Los_Angeles",
    },
  } as never);
  return { fetch, tools };
}

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
      Response.json({
        id: DOC_ID,
        mimeType: "application/vnd.google-apps.document",
        name: "Q4 plan",
      }),
      new Response("# Q4 plan\n\nShip it.", {
        headers: { "content-type": "text/markdown" },
      }),
      Response.json({
        id: DOC_ID,
        mimeType: "application/vnd.google-apps.document",
        name: "Q4 plan",
      }),
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
      "(mimeType = 'application/vnd.google-apps.document') and trashed = false and fullText contains 'Bob\\'s plan'",
    );
    expect(search).toMatchObject({
      files: [{ fileId: DOC_ID, title: "Q4 plan", type: "document" }],
      truncated: true,
    });

    const link = `https://docs.google.com/document/d/${DOC_ID}/edit?resourcekey=0-key`;
    const doc = await run(tools, "readGoogleDoc", { document: link });
    const [get, exported] = [fetch.mock.calls[1]![0], fetch.mock.calls[2]![0]];
    expect(get.operation).toBe("google.drive.file.get");
    expect(exported.operation).toBe("google.drive.file.export");
    expect(new URL(exported.request.url).pathname).toBe(
      `/drive/v3/files/${DOC_ID}/export`,
    );
    // Google needs the resource key of an older Doc shared by link.
    for (const call of [get, exported]) {
      expect(call.request.headers.get("X-Goog-Drive-Resource-Keys")).toBe(
        `${DOC_ID}/0-key`,
      );
    }
    expect(doc).toMatchObject({
      content: "# Q4 plan\n\nShip it.",
      documentId: DOC_ID,
      title: "Q4 plan",
      truncated: false,
    });

    const comments = await run(tools, "listGoogleFileComments", {
      file: DOC_ID,
    });
    expect(fetch.mock.calls.slice(3).map(([call]) => call.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.comments.list",
    ]);
    expect(comments).toEqual({
      target: "listGoogleFileComments",
      comments: [
        {
          author: "Bob",
          commentId: "c1",
          content: "Which quarter?",
          quotedText: "Ship it.",
          replies: [
            { author: "Alice", content: "Q4." },
            { action: "resolve", author: "Bob", content: "" },
          ],
          resolved: true,
        },
      ],
      fileId: DOC_ID,
      nextPageToken: "page-2",
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

  it("reads every tab of a Sheet as CSV, and the text and notes of each slide", async () => {
    const SHEET_ID = "1SheetIdAbCdEfGhIjKlMnOp";
    const SLIDES_ID = "1SlidesIdAbCdEfGhIjKlMn";
    const { fetch, tools } = docsTools(
      Response.json({
        id: SHEET_ID,
        mimeType: "application/vnd.google-apps.spreadsheet",
        name: "Budget",
      }),
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
      Response.json({
        id: SLIDES_ID,
        mimeType: "application/vnd.google-apps.presentation",
        name: "Kickoff",
      }),
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
    const batchGet = new URL(fetch.mock.calls[2]![0].request.url);
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
      spreadsheetId: SHEET_ID,
      tabs: ["Q4", "Bob's tab"],
      title: "Budget",
      truncated: false,
    });

    const slides = await run(tools, "readGoogleSlides", {
      presentation: `https://docs.google.com/presentation/d/${SLIDES_ID}/edit`,
    });
    expect(new URL(fetch.mock.calls[4]![0].request.url).host).toBe(
      "slides.googleapis.com",
    );
    expect(slides).toMatchObject({
      presentationId: SLIDES_ID,
      slideCount: 2,
      slides: [
        { notes: "Say hello.", slideNumber: 1, text: "Kickoff\nQ4 | Ship" },
        { slideNumber: 2, text: "" },
      ],
      title: "Kickoff",
      truncated: false,
    });
  });
});
