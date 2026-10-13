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

function run(
  tools: ReturnType<typeof docsTools>["tools"],
  name: string,
  input: Record<string, unknown>,
) {
  const tool = tools[name]!;
  return tool.execute!(tool.prepareArguments!(input), { toolCallId: name });
}

describe("Google Docs tools", () => {
  beforeEach(() => stubGoogleEnv());
  afterEach(() => vi.unstubAllEnvs());

  it("finds a Doc, reads it from a shared link, and lists its comments", async () => {
    const { fetch, tools } = docsTools(
      Response.json({
        files: [
          {
            id: DOC_ID,
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

    const search = await run(tools, "searchGoogleDocs", {
      query: "Bob's plan",
    });
    const searchUrl = new URL(fetch.mock.calls[0]![0].request.url);
    expect(searchUrl.pathname).toBe("/drive/v3/files");
    expect(searchUrl.searchParams.get("q")).toBe(
      "mimeType = 'application/vnd.google-apps.document' and trashed = false and fullText contains 'Bob\\'s plan'",
    );
    expect(search).toMatchObject({
      documents: [{ documentId: DOC_ID, title: "Q4 plan" }],
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

    const comments = await run(tools, "listGoogleDocComments", {
      document: DOC_ID,
    });
    expect(fetch.mock.calls.slice(3).map(([call]) => call.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.comments.list",
    ]);
    expect(comments).toEqual({
      target: "listGoogleDocComments",
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
      documentId: DOC_ID,
      nextPageToken: "page-2",
    });
  });

  it("explains a Doc Junior cannot open, a file that is not a Doc, and a grant without Drive access", async () => {
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
      `Junior's Google account (${ACCOUNT_EMAIL}) cannot open this Doc`,
    );
    await expect(
      run(tools, "listGoogleDocComments", { document: DOC_ID }),
    ).rejects.toThrow("is not a Google Doc");
    await expect(
      run(tools, "readGoogleDoc", { document: DOC_ID }),
    ).rejects.toThrow("A Junior admin must reconnect it");
  });
});
