import { bindPluginTools } from "@sentry/junior-testing/plugin-tool";
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { ACCOUNT_EMAIL, stubGoogleEnv } from "./fixture";

const DECK_ID = "1DeCkIdAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const DECK_LINK = `https://docs.google.com/presentation/d/${DECK_ID}/edit`;
const REQUESTER = "alice@example.com";
const SANDBOX_ROOT = "/sandbox";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function slidesTools(responses: Response[], curlExitCode = 0) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const run = vi.fn(async ({ cmd }: { cmd: string }) => ({
    exitCode: cmd === "curl" ? curlExitCode : 0,
    stderr: cmd === "curl" && curlExitCode ? "403 Forbidden" : "",
    stdout: "",
  }));
  const readFile = vi.fn(async () => PNG);
  const tools = bindPluginTools(googlePlugin().hooks!.tools!(), {
    egress: { fetch },
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
    });
  });

  it("refuses edits that either account cannot make, and malformed requests", async () => {
    const input = {
      presentation: DECK_LINK,
      requests: [{ deleteObject: { objectId: "s1" } }],
      revision_id: "rev-1",
    };
    const readOnly = slidesTools([deckFile(false)]);
    await expect(readOnly.call("updateGoogleSlides", input)).rejects.toThrow(
      `Your Google account (${ACCOUNT_EMAIL}) cannot edit "Roadmap"`,
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

  it("reads a deck outline or one full slide, always with the revision", async () => {
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
      /^revisionId,pageSize,slides\(objectId,/,
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
