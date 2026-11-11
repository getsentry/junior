import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { convertMarkdown } from "../src/tools/doc-markdown";
import { ACCOUNT_EMAIL, stubGoogleEnv } from "./fixture";

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const REQUESTER = "alice@example.com";
const DOC_LINK = `https://docs.google.com/document/d/${DOC_ID}/edit`;

function docTools(responses: Response[], requester: string | null = REQUESTER) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const tools = googlePlugin().hooks!.tools!({
    egress: { fetch },
    users: {
      resolveActor: async () =>
        requester
          ? { user: { email: requester, id: "user-1", identities: [] } }
          : undefined,
      resolveTimezone: async () => "America/Los_Angeles",
    },
  } as never);
  const run = (name: string, input: Record<string, unknown>) => {
    const tool = tools[name]!;
    return tool.execute!(tool.prepareArguments!(input), { toolCallId: name });
  };
  /** Operation and JSON body of each Google request, in order. */
  const calls = async () =>
    Promise.all(
      fetch.mock.calls.map(async ([call]) => ({
        body: call.request.body ? await call.request.clone().json() : undefined,
        operation: call.operation as string,
        url: new URL(call.request.url),
      })),
    );
  return { calls, run };
}

function driveFile(canEdit = true) {
  return Response.json({
    capabilities: { canEdit },
    id: DOC_ID,
    mimeType: "application/vnd.google-apps.document",
    name: "Rethinking",
    webViewLink: DOC_LINK,
  });
}

function permissions(...items: Array<Record<string, string>>) {
  return Response.json({ permissions: items });
}

/** A Docs body: a section break, then one paragraph per text. */
function docBody(...paragraphs: string[]) {
  let index = 1;
  const content: unknown[] = [{ endIndex: 1 }];
  for (const text of paragraphs) {
    index += text.length;
    content.push({
      endIndex: index,
      paragraph: { elements: [{ textRun: { content: text } }] },
    });
  }
  return Response.json({ body: { content }, revisionId: "rev-1" });
}

describe("Google Docs Markdown", () => {
  it("converts headings, lists, inline styles, and code to Docs text and ranges", () => {
    const converted = convertMarkdown(
      [
        "# Plan",
        "",
        "Ship **fast** and *well*, see [the doc](https://example.com) and `npm`.",
        "Keep snake_case_names.",
        "",
        "- One",
        "  - Two",
        "1. Three",
        "",
        "```",
        "a *b*",
        "```",
        "[bad](javascript:alert(1))",
      ].join("\n"),
    );

    expect(converted.text).toBe(
      [
        "Plan",
        "Ship fast and well, see the doc and npm. Keep snake_case_names.",
        "One",
        "\tTwo",
        "Three",
        "a *b*",
        "[bad](javascript:alert(1))",
      ].join("\n"),
    );
    const at = (text: string) => converted.text.indexOf(text);
    expect(converted.paragraphs).toEqual([
      { end: 4, start: 0, style: "HEADING_1" },
      { end: converted.text.length, start: 5, style: "NORMAL_TEXT" },
    ]);
    expect(converted.textStyles).toEqual([
      { bold: true, end: at("fast") + 4, start: at("fast") },
      { end: at("well") + 4, italic: true, start: at("well") },
      {
        end: at("the doc") + 7,
        link: "https://example.com",
        start: at("the doc"),
      },
      { code: true, end: at("npm") + 3, start: at("npm") },
      { code: true, end: at("a *b*") + 5, start: at("a *b*") },
    ]);
    // A numbered item continues the open list block; the first item sets it.
    expect(converted.lists).toEqual([
      { end: at("Three") + 5, ordered: false, start: at("One") },
    ]);
  });
});

describe("Google Docs write tools", () => {
  beforeEach(() => stubGoogleEnv());
  afterEach(() => vi.unstubAllEnvs());

  it("adds Markdown to the end of a Doc after checking both accounts can edit it", async () => {
    const { calls, run } = docTools([
      driveFile(),
      permissions(
        { role: "reader", type: "user", emailAddress: "bob@example.com" },
        { role: "writer", type: "user", emailAddress: "Alice@example.com" },
      ),
      docBody("Intro\n"),
      Response.json({ documentId: DOC_ID, replies: [] }),
    ]);

    const result = await run("insertGoogleDocContent", {
      content: "## Agenda\n\n- Plan\n- Ship",
      document: DOC_LINK,
    });

    const [, list, , update] = await calls();
    expect((await calls()).map((call) => call.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.permissions.list",
      "google.docs.document.get",
      "google.docs.document.batchUpdate",
    ]);
    expect(list!.url.pathname).toBe(`/drive/v3/files/${DOC_ID}/permissions`);
    expect(update!.url.host).toBe("docs.googleapis.com");
    expect(update!.url.pathname).toBe(`/v1/documents/${DOC_ID}:batchUpdate`);
    // "Intro\n" ends at index 7. The text goes before its final newline, after
    // a newline that ends "Intro".
    expect(update!.body).toEqual({
      requests: [
        {
          insertText: { location: { index: 6 }, text: "\nAgenda\nPlan\nShip" },
        },
        {
          updateTextStyle: expect.objectContaining({
            range: { endIndex: 23, startIndex: 7 },
            textStyle: {},
          }),
        },
        {
          updateParagraphStyle: {
            fields: "namedStyleType",
            paragraphStyle: { namedStyleType: "HEADING_2" },
            range: { endIndex: 14, startIndex: 7 },
          },
        },
        {
          updateParagraphStyle: {
            fields: "namedStyleType",
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            range: { endIndex: 24, startIndex: 14 },
          },
        },
        { deleteParagraphBullets: { range: { endIndex: 24, startIndex: 7 } } },
        {
          createParagraphBullets: {
            bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
            range: { endIndex: 24, startIndex: 14 },
          },
        },
      ],
      writeControl: { requiredRevisionId: "rev-1" },
    });
    expect(result).toEqual({
      target: "insertGoogleDocContent",
      document_id: DOC_ID,
      title: "Rethinking",
      url: DOC_LINK,
    });
  });

  it("replaces the whole body, and replaces text without reading the body", async () => {
    const { calls, run } = docTools([
      driveFile(),
      permissions({ domain: "example.com", role: "writer", type: "domain" }),
      docBody("Old\n", "Older\n"),
      Response.json({ documentId: DOC_ID, replies: [] }),
      driveFile(),
      permissions({ role: "writer", type: "anyone" }),
      Response.json({
        documentId: DOC_ID,
        replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
      }),
    ]);

    await run("replaceGoogleDocContent", {
      content: "New",
      document: DOC_ID,
    });
    const replaced = await run("replaceGoogleDocText", {
      document: DOC_ID,
      find: "Q3",
      replace: "Q4",
    });

    const all = await calls();
    expect(all[3]!.body.requests.slice(0, 2)).toEqual([
      { deleteContentRange: { range: { endIndex: 10, startIndex: 1 } } },
      { insertText: { location: { index: 1 }, text: "New" } },
    ]);
    expect(all.slice(4).map((call) => call.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.permissions.list",
      "google.docs.document.batchUpdate",
    ]);
    expect(all[6]!.body).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { matchCase: true, text: "Q3" },
            replaceText: "Q4",
          },
        },
      ],
    });
    expect(replaced).toMatchObject({ occurrences_changed: 3 });
  });

  it("creates a Doc shared only with the requester, then writes its content", async () => {
    const { calls, run } = docTools([
      Response.json({ documentId: DOC_ID, revisionId: "rev-0", title: "Plan" }),
      Response.json({ id: "perm-1" }),
      Response.json({ documentId: DOC_ID, replies: [] }),
    ]);

    const result = await run("createGoogleDoc", {
      content: "Hello",
      title: "Plan",
    });

    const [create, share, update] = await calls();
    expect(create!.url.toString()).toBe(
      "https://docs.googleapis.com/v1/documents",
    );
    expect(create!.body).toEqual({ title: "Plan" });
    expect(share!.operation).toBe("google.drive.permission.create");
    expect(share!.url.searchParams.get("sendNotificationEmail")).toBe("false");
    expect(share!.body).toEqual({
      emailAddress: REQUESTER,
      role: "writer",
      type: "user",
    });
    expect(update!.body.requests[0]).toEqual({
      insertText: { location: { index: 1 }, text: "Hello" },
    });
    expect(update!.body.writeControl).toEqual({ requiredRevisionId: "rev-0" });
    expect(result).toEqual({
      target: "createGoogleDoc",
      document_id: DOC_ID,
      title: "Plan",
      url: DOC_LINK,
    });
  });

  it("refuses an edit Junior's account or the requester cannot make", async () => {
    const { calls, run } = docTools([
      driveFile(false),
      driveFile(),
      permissions(
        { emailAddress: "eng@example.com", role: "writer", type: "group" },
        { emailAddress: REQUESTER, role: "commenter", type: "user" },
      ),
    ]);
    const input = { document: DOC_ID, find: "a", replace: "b" };

    const readOnly = run("replaceGoogleDocText", input);
    await expect(readOnly).rejects.toThrow(PluginToolInputError);
    await expect(readOnly).rejects.toThrow(
      `Your Google account (${ACCOUNT_EMAIL}) cannot edit "Rethinking"`,
    );
    await expect(run("replaceGoogleDocText", input)).rejects.toThrow(
      `${REQUESTER} is not an editor`,
    );
    expect(
      (await calls()).some(
        (call) => call.operation === "google.docs.document.batchUpdate",
      ),
    ).toBe(false);
  });

  it("refuses to create a Doc for an unknown or outside requester", async () => {
    await expect(
      docTools([], null).run("createGoogleDoc", { title: "Plan" }),
    ).rejects.toThrow("The requester's email is unknown");
    await expect(
      docTools([], "eve@other.com").run("createGoogleDoc", { title: "Plan" }),
    ).rejects.toThrow("Not allowed: eve@other.com");
  });
});
