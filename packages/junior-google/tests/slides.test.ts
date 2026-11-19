// oxlint-disable anti-slop/no-shape-in-symbol-names -- `shape` is a Slides API field.
import { bindPluginTools } from "@sentry/junior-testing/plugin-tool";
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { ACCOUNT_EMAIL, stubGoogleEnv, withReadCheck } from "./fixture";

const DECK_ID = "1DeCkIdAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const DECK_LINK = `https://docs.google.com/presentation/d/${DECK_ID}/edit`;
const REQUESTER = "alice@example.com";
const SANDBOX_ROOT = "/sandbox";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function slidesTools(
  responses: Response[],
  curlExitCode = 0,
  readableIds: readonly string[] = [DECK_ID],
) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const run = vi.fn(async ({ cmd }: { cmd: string }) => ({
    exitCode: cmd === "curl" ? curlExitCode : 0,
    stderr: cmd === "curl" && curlExitCode ? "403 Forbidden" : "",
    stdout: "",
  }));
  const readFile = vi.fn(async () => PNG);
  const tools = bindPluginTools(googlePlugin().hooks!.tools!(), {
    egress: { fetch: withReadCheck(fetch, readableIds) },
    sandbox: { readFile, root: SANDBOX_ROOT, run, writeFile: vi.fn() },
    users: {
      resolveActor: async () => ({
        user: { email: REQUESTER, id: "user-1", identities: [] },
      }),
      resolveTimezone: async () => "America/Los_Angeles",
    },
  } as never);
  const call = (name: string, input: Record<string, unknown>) => {
    const tool = tools[name];
    return tool.execute(tool.prepareArguments!(input), { toolCallId: name });
  };
  /** Operation, URL, and JSON body of each Google request, in order. */
  const calls = async () =>
    Promise.all(
      fetch.mock.calls.map(async ([request]) => ({
        body: request.request.body
          ? await request.request.clone().json()
          : undefined,
        operation: request.operation as string,
        url: new URL(request.request.url),
      })),
    );
  return { call, calls, run };
}

function deckFile(canEdit = true) {
  return Response.json({
    capabilities: { canEdit },
    id: DECK_ID,
    mimeType: "application/vnd.google-apps.presentation",
    name: "Roadmap",
    webViewLink: DECK_LINK,
  });
}

function permissions(...items: Array<Record<string, string>>) {
  return Response.json({ permissions: items });
}

const PAGE_SIZE = {
  height: { magnitude: 5143500, unit: "EMU" },
  width: { magnitude: 9144000, unit: "EMU" },
};

/** A text shape at a position and size in points. */
function textBox(
  objectId: string,
  box: { height: number; left: number; top: number; width: number },
  text: string,
  extra: { fontSize?: number; placeholder?: string } = {},
) {
  return {
    objectId,
    shape: {
      ...(extra.placeholder
        ? { placeholder: { type: extra.placeholder } }
        : undefined),
      text: {
        textElements: text
          ? [
              {
                textRun: {
                  content: text,
                  ...(extra.fontSize
                    ? {
                        style: {
                          fontSize: { magnitude: extra.fontSize, unit: "PT" },
                        },
                      }
                    : undefined),
                },
              },
            ]
          : [],
      },
    },
    size: {
      height: { magnitude: box.height * 12700, unit: "EMU" },
      width: { magnitude: box.width * 12700, unit: "EMU" },
    },
    transform: {
      scaleX: 1,
      scaleY: 1,
      translateX: box.left * 12700,
      translateY: box.top * 12700,
      unit: "EMU",
    },
  };
}

/** The deck read that updateGoogleSlides makes to check its edit. */
function checkedDeck(...slides: Array<Record<string, unknown>>) {
  return Response.json({ pageSize: PAGE_SIZE, slides });
}

describe("Google Slides tools", () => {
  beforeEach(() => stubGoogleEnv());
  afterEach(() => vi.unstubAllEnvs());

  it("applies batchUpdate requests at the read revision after checking both accounts can edit", async () => {
    const { call, calls } = slidesTools([
      deckFile(),
      permissions({ role: "writer", type: "domain", domain: "example.com" }),
      Response.json({
        presentationId: DECK_ID,
        replies: [{ createSlide: { objectId: "s2" } }, {}],
        writeControl: { requiredRevisionId: "rev-2" },
      }),
      checkedDeck({ objectId: "s1" }, { objectId: "s2" }),
    ]);
    const requests = [
      { createSlide: { insertionIndex: 1, objectId: "s2" } },
      { insertText: { objectId: "title_1", text: "Q4" } },
    ];

    const result = await call("updateGoogleSlides", {
      presentation: DECK_LINK,
      requests,
      revision_id: "rev-1",
    });

    const sent = await calls();
    expect(sent.map((item) => item.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.permissions.list",
      "google.slides.presentation.batchUpdate",
      "google.slides.presentation.get",
    ]);
    expect(sent[2]?.url.href).toBe(
      `https://slides.googleapis.com/v1/presentations/${DECK_ID}:batchUpdate`,
    );
    expect(sent[2]?.body).toEqual({
      requests,
      writeControl: { requiredRevisionId: "rev-1" },
    });
    expect(result).toMatchObject({
      presentation_id: DECK_ID,
      replies: [{ createSlide: { objectId: "s2" } }, {}],
      revision_id: "rev-2",
      title: "Roadmap",
      url: DECK_LINK,
      changed_slides: ["s2"],
      issues: [],
    });
  });

  it("reports layout problems on the slides that an edit touched", async () => {
    const longText =
      "Every customer request goes through the retry path. ".repeat(6);
    const { call } = slidesTools([
      deckFile(),
      permissions({ role: "writer", type: "user", emailAddress: REQUESTER }),
      Response.json({
        replies: [{ createSlide: { objectId: "s2" } }],
        writeControl: { requiredRevisionId: "rev-2" },
      }),
      checkedDeck(
        // Not touched by the edit, so its empty placeholder is not reported.
        {
          objectId: "s1",
          pageElements: [
            textBox(
              "old_body",
              { height: 200, left: 40, top: 100, width: 640 },
              "",
              { placeholder: "BODY" },
            ),
          ],
        },
        {
          objectId: "s2",
          pageElements: [
            textBox(
              "s2_title",
              { height: 50, left: 40, top: 30, width: 640 },
              "Retries hid timeouts",
              { fontSize: 28, placeholder: "TITLE" },
            ),
            textBox(
              "s2_body",
              { height: 200, left: 40, top: 100, width: 640 },
              "",
              { placeholder: "BODY" },
            ),
            textBox(
              "s2_box",
              { height: 40, left: 40, top: 100, width: 300 },
              longText,
              { fontSize: 18 },
            ),
            textBox(
              "s2_note",
              { height: 20, left: 600, top: 395, width: 200 },
              "Source: logs",
              { fontSize: 9 },
            ),
          ],
        },
      ),
    ]);

    const result = await call("updateGoogleSlides", {
      presentation: DECK_LINK,
      requests: [
        { createSlide: { slideLayoutReference: { layoutId: "layout_tb" } } },
      ],
      revision_id: "rev-1",
    });

    expect(result).toMatchObject({ changed_slides: ["s2"] });
    const issues = (result as { issues: Array<Record<string, string>> }).issues;
    expect(issues.map((issue) => [issue.element_id, issue.problem])).toEqual([
      ["s2_body", "Empty BODY placeholder. Fill it or delete it."],
      [
        "s2_box",
        expect.stringContaining("Text probably needs more height than its box"),
      ],
      ["s2_note", expect.stringContaining("Text is 9 pt.")],
      ["s2_note", "Text box goes past the edge of the slide."],
    ]);
    expect(issues.every((issue) => issue.slide_id === "s2")).toBe(true);
  });

  it("refuses requests that would not do what they seem to, and explains a missing layout", async () => {
    const input = { presentation: DECK_LINK, revision_id: "rev-1" };
    const editor = () =>
      permissions({ role: "writer", type: "user", emailAddress: REQUESTER });
    const refused: Array<[Record<string, unknown>, string]> = [
      [
        {
          updatePageElementTransform: {
            applyMode: "ABSOLUTE",
            objectId: "box",
            transform: { translateX: 10, translateY: 10, unit: "PT" },
          },
        },
        "an omitted scaleX or scaleY becomes 0",
      ],
      [
        {
          updateSlideProperties: {
            fields: "layoutObjectId",
            objectId: "s1",
            slideProperties: { layoutObjectId: "layout_blank" },
          },
        },
        "A slide's layout cannot change.",
      ],
    ];
    for (const [request, message] of refused) {
      const tools = slidesTools([deckFile(), editor()]);
      await expect(
        tools.call("updateGoogleSlides", { ...input, requests: [request] }),
      ).rejects.toThrow(message);
      expect((await tools.calls()).map((item) => item.operation)).not.toContain(
        "google.slides.presentation.batchUpdate",
      );
    }

    const missing = slidesTools([
      deckFile(),
      editor(),
      Response.json(
        {
          error: {
            message: "Invalid requests[0].createSlide: layout not found.",
          },
        },
        { status: 400 },
      ),
    ]);
    await expect(
      missing.call("updateGoogleSlides", {
        ...input,
        requests: [
          {
            createSlide: {
              slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
            },
          },
        ],
      }),
    ).rejects.toThrow(
      "use a layoutId from the layouts that readGoogleSlidesLayout returns",
    );
  });

  it("says the edit applied when the check read fails", async () => {
    const { call } = slidesTools([
      deckFile(),
      permissions({ role: "writer", type: "user", emailAddress: REQUESTER }),
      Response.json({
        replies: [{}],
        writeControl: { requiredRevisionId: "rev-2" },
      }),
      Response.json({ error: { message: "backend" } }, { status: 500 }),
    ]);
    await expect(
      call("updateGoogleSlides", {
        presentation: DECK_LINK,
        requests: [{ deleteObject: { objectId: "s1" } }],
        revision_id: "rev-1",
      }),
    ).rejects.toThrow("The edit applied at revision rev-2, but reading");
  });

  it("refuses edits that either account cannot make, and malformed requests", async () => {
    const input = {
      presentation: DECK_LINK,
      requests: [{ deleteObject: { objectId: "s1" } }],
      revision_id: "rev-1",
    };
    const readOnly = slidesTools([deckFile(false)]);
    // Errors before the requester check say nothing about the file.
    await expect(readOnly.call("updateGoogleSlides", input)).rejects.toThrow(
      `Your Google account (${ACCOUNT_EMAIL}) cannot edit this file.`,
    );

    const viewer = slidesTools([
      deckFile(),
      permissions({ role: "reader", type: "user", emailAddress: REQUESTER }),
    ]);
    await expect(viewer.call("updateGoogleSlides", input)).rejects.toThrow(
      `Only people who can edit this presentation can ask you to change it, and ${REQUESTER} is not an editor.`,
    );
    expect((await viewer.calls()).map((item) => item.operation)).not.toContain(
      "google.slides.presentation.batchUpdate",
    );

    expect(() =>
      slidesTools([]).call("updateGoogleSlides", {
        ...input,
        requests: [{ deleteObject: {}, insertText: {} }],
      }),
    ).toThrow(PluginToolInputError);
  });

  it("adds a Sheets chart only from a Sheet the requester can open, and only YouTube videos", async () => {
    const SHEET_ID = "1ShEeTiDaBcDeFgHiJkLmNoP";
    const sheetFile = () =>
      Response.json({
        id: SHEET_ID,
        mimeType: "application/vnd.google-apps.spreadsheet",
        name: "Numbers",
      });
    const editor = () =>
      permissions({ role: "writer", type: "user", emailAddress: REQUESTER });
    const chart = {
      presentation: DECK_LINK,
      requests: [
        {
          createSheetsChart: {
            chartId: 1,
            linkingMode: "LINKED",
            spreadsheetId: SHEET_ID,
          },
        },
      ],
      revision_id: "rev-1",
    };

    const shared = slidesTools(
      [
        deckFile(),
        editor(),
        sheetFile(),
        Response.json({ replies: [{}] }),
        checkedDeck(),
      ],
      0,
      [DECK_ID, SHEET_ID],
    );
    await expect(
      shared.call("updateGoogleSlides", chart),
    ).resolves.toMatchObject({ presentation_id: DECK_ID });
    const sent = await shared.calls();
    expect(sent[2]?.url.pathname).toBe(`/drive/v3/files/${SHEET_ID}`);
    expect(sent[3]?.operation).toBe("google.slides.presentation.batchUpdate");

    const hidden = slidesTools([deckFile(), editor(), sheetFile()]);
    await expect(hidden.call("updateGoogleSlides", chart)).rejects.toThrow(
      `Only people who can open this file can ask you to read it, and ${REQUESTER} cannot.`,
    );
    expect((await hidden.calls()).map((item) => item.operation)).not.toContain(
      "google.slides.presentation.batchUpdate",
    );

    const video = slidesTools([deckFile(), editor()]);
    await expect(
      video.call("updateGoogleSlides", {
        ...chart,
        requests: [{ createVideo: { id: SHEET_ID, source: "DRIVE" } }],
      }),
    ).rejects.toThrow("Only YouTube videos can be added.");
    expect((await video.calls()).map((item) => item.operation)).not.toContain(
      "google.slides.presentation.batchUpdate",
    );

    // Google also reads snake_case names, which the checks do not read. A
    // refresh reads a Sheet that the request does not name.
    const refused: Array<[Array<Record<string, unknown>>, string]> = [
      [
        [{ create_video: { id: SHEET_ID, source: "DRIVE" } }],
        "Write Slides API field names in camelCase, not create_video.",
      ],
      [
        [{ createSheetsChart: { chartId: 1, spreadsheet_id: SHEET_ID } }],
        "Write Slides API field names in camelCase, not spreadsheet_id.",
      ],
      [
        [{ refreshSheetsChart: { objectId: "chart1" } }],
        "refreshSheetsChart is not supported",
      ],
      [
        [
          {
            createSheetsChart: {
              chartId: 1,
              spreadsheetId: `${SHEET_ID}/../${DECK_ID}`,
            },
          },
        ],
        "spreadsheetId must be a Drive file id",
      ],
    ];
    for (const [requests, message] of refused) {
      const tools = slidesTools([deckFile(), editor()], 0, [DECK_ID, SHEET_ID]);
      await expect(
        tools.call("updateGoogleSlides", { ...chart, requests }),
      ).rejects.toThrow(message);
      expect((await tools.calls()).map((item) => item.operation)).not.toContain(
        "google.slides.presentation.batchUpdate",
      );
    }
  });

  it("reads a deck outline or one full slide, with the revision when the account can edit", async () => {
    const outline = slidesTools([
      deckFile(),
      Response.json({ revisionId: "rev-1", slides: [{ objectId: "s1" }] }),
    ]);
    await expect(
      outline.call("readGoogleSlidesLayout", { presentation: DECK_LINK }),
    ).resolves.toMatchObject({
      content: { slides: [{ objectId: "s1" }] },
      presentation_id: DECK_ID,
      revision_id: "rev-1",
      title: "Roadmap",
    });
    const [, deck] = await outline.calls();
    expect(deck?.url.pathname).toBe(`/v1/presentations/${DECK_ID}`);
    expect(deck?.url.searchParams.get("fields")).toMatch(
      /^revisionId,pageSize,layouts\(objectId,.*\),slides\(objectId,/,
    );

    const slide = slidesTools([
      deckFile(),
      Response.json({ objectId: "g1:2", revisionId: "rev-1" }),
    ]);
    await slide.call("readGoogleSlidesLayout", {
      fields: "pageElements(objectId)",
      presentation: DECK_ID,
      slide_object_id: "g1:2",
    });
    const [, page] = await slide.calls();
    expect(page?.operation).toBe("google.slides.page.get");
    expect(page?.url.pathname).toBe(`/v1/presentations/${DECK_ID}/pages/g1:2`);
    expect(page?.url.searchParams.get("fields")).toBe(
      "revisionId,pageElements(objectId)",
    );

    // A revisionId inside a nested selection is not the deck's revision.
    const nested = slidesTools([
      deckFile(),
      Response.json({ revisionId: "rev-1", slides: [{ objectId: "s1" }] }),
    ]);
    await expect(
      nested.call("readGoogleSlidesLayout", {
        fields: "slides(objectId,revisionId)",
        presentation: DECK_ID,
      }),
    ).resolves.toMatchObject({ revision_id: "rev-1" });
    const [, nestedDeck] = await nested.calls();
    expect(nestedDeck?.url.searchParams.get("fields")).toBe(
      "revisionId,slides(objectId,revisionId)",
    );

    // Google returns no revision to an account that can only view the deck.
    const viewOnly = slidesTools([
      deckFile(false),
      Response.json({ slides: [{ objectId: "s1" }] }),
    ]);
    const layout = await viewOnly.call("readGoogleSlidesLayout", {
      presentation: DECK_LINK,
    });
    expect(layout).toMatchObject({ content: { slides: [{ objectId: "s1" }] } });
    expect(layout).not.toHaveProperty("revision_id");

    const huge = slidesTools([
      deckFile(),
      Response.json({ revisionId: "rev-1", text: "x".repeat(100_001) }),
    ]);
    await expect(
      huge.call("readGoogleSlidesLayout", { presentation: DECK_LINK }),
    ).rejects.toThrow("Read one slide with slide_object_id");
  });

  it("renders a slide, downloads it in the sandbox, and returns the image", async () => {
    const contentUrl = "https://lh7-us.googleusercontent.com/thumb=s800";
    const { call, calls, run } = slidesTools([
      deckFile(),
      Response.json({ contentUrl, height: 450, width: 800 }),
    ]);

    const result = await call("getGoogleSlideThumbnail", {
      presentation: DECK_LINK,
      slide_object_id: "g1:2",
    });

    const [, thumbnail] = await calls();
    expect(thumbnail?.url.pathname).toBe(
      `/v1/presentations/${DECK_ID}/pages/g1:2/thumbnail`,
    );
    expect(
      thumbnail?.url.searchParams.get("thumbnailProperties.thumbnailSize"),
    ).toBe("MEDIUM");
    const path = `${SANDBOX_ROOT}/slides/${DECK_ID}/g1_2.png`;
    expect(run).toHaveBeenLastCalledWith({
      args: ["-fsS", "--max-time", "30", "-o", path, "--", contentUrl],
      cmd: "curl",
    });
    expect(result).toEqual({
      content: [
        { text: expect.stringContaining(path), type: "text" },
        { data: "iVBORw==", mimeType: "image/png", type: "image" },
      ],
      details: {
        height: 450,
        path,
        target: "getGoogleSlideThumbnail",
        width: 800,
      },
    });

    const offHost = slidesTools([
      deckFile(),
      Response.json({
        contentUrl: "https://evil.example.com/x",
        height: 1,
        width: 1,
      }),
    ]);
    await expect(
      offHost.call("getGoogleSlideThumbnail", {
        presentation: DECK_LINK,
        slide_object_id: "s1",
      }),
    ).rejects.toThrow("outside .googleusercontent.com");

    const failed = slidesTools(
      [deckFile(), Response.json({ contentUrl, height: 1, width: 1 })],
      22,
    );
    await expect(
      failed.call("getGoogleSlideThumbnail", {
        presentation: DECK_LINK,
        slide_object_id: "s1",
      }),
    ).rejects.toThrow("Could not download the slide thumbnail: 403 Forbidden");
  });
});
