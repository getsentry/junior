import { bindPluginTools } from "@sentry/junior-testing/plugin-tool";
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
  const tools = bindPluginTools(googlePlugin().hooks!.tools!(), {
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
    const tool = tools[name];
    return tool.execute(tool.prepareArguments!(input), { toolCallId: name });
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
    const startIndex = index;
    index += text.length;
    content.push({
      endIndex: index,
      paragraph: { elements: [{ startIndex, textRun: { content: text } }] },
      startIndex,
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

    // Empty blocks at either end add no leading or final newline. Inside the
    // text, an empty code line stays.
    expect(
      convertMarkdown(
        ["# ", "```", "", "a", "", "b", "", "```", "- "].join("\n"),
      ).text,
    ).toBe("a\n\nb");
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
      revision_id: "rev-1",
    });

    const [, list, , update] = await calls();
    expect((await calls()).map((call) => call.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.permissions.list",
      "google.docs.document.get",
      "google.docs.document.batchUpdate",
    ]);
    expect(list.url.pathname).toBe(`/drive/v3/files/${DOC_ID}/permissions`);
    expect(update.url.host).toBe("docs.googleapis.com");
    expect(update.url.pathname).toBe(`/v1/documents/${DOC_ID}:batchUpdate`);
    // "Intro\n" ends at index 7. The text goes before its final newline, after
    // a newline that ends "Intro".
    expect(update.body).toEqual({
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

  it("keeps an image paragraph apart, and refuses to add text before a table", async () => {
    const imageOnly = Response.json({
      body: {
        content: [
          { endIndex: 1 },
          {
            endIndex: 3,
            paragraph: {
              elements: [
                { startIndex: 1 },
                { startIndex: 2, textRun: { content: "\n" } },
              ],
            },
            startIndex: 1,
          },
        ],
      },
      revisionId: "rev-1",
    });
    const tableFirst = Response.json({
      body: {
        content: [
          { endIndex: 1 },
          { endIndex: 9, startIndex: 1 },
          {
            endIndex: 10,
            paragraph: {
              elements: [{ startIndex: 9, textRun: { content: "\n" } }],
            },
            startIndex: 9,
          },
        ],
      },
      revisionId: "rev-1",
    });
    const editable = () => [
      driveFile(),
      permissions({ emailAddress: REQUESTER, role: "writer", type: "user" }),
    ];
    const { calls, run } = docTools([
      ...editable(),
      imageOnly,
      Response.json({ documentId: DOC_ID, replies: [] }),
      ...editable(),
      tableFirst,
    ]);

    await run("insertGoogleDocContent", {
      content: "Hi",
      document: DOC_ID,
      revision_id: "rev-1",
    });
    await expect(
      run("insertGoogleDocContent", {
        content: "Hi",
        document: DOC_ID,
        position: "start",
        revision_id: "rev-1",
      }),
    ).rejects.toThrow('"Rethinking" starts with a table');

    // The image paragraph is not empty, so the text goes after a new line.
    expect((await calls())[3].body.requests[0]).toEqual({
      insertText: { location: { index: 2 }, text: "\nHi" },
    });
  });

  it("replaces the whole body, and replaces text only in the first tab", async () => {
    const { calls, run } = docTools([
      driveFile(),
      permissions({ domain: "example.com", role: "writer", type: "domain" }),
      docBody("Old\n", "Older\n"),
      Response.json({ documentId: DOC_ID, replies: [] }),
      driveFile(),
      permissions({ role: "writer", type: "anyone" }),
      Response.json({
        revisionId: "rev-2",
        tabs: [
          { tabProperties: { tabId: "t.0" } },
          { tabProperties: { tabId: "t.1" } },
        ],
      }),
      Response.json({
        documentId: DOC_ID,
        replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
      }),
    ]);

    await run("replaceGoogleDocContent", {
      content: "New",
      document: DOC_ID,
      revision_id: "rev-1",
    });
    const replaced = await run("replaceGoogleDocText", {
      document: DOC_ID,
      find: "Q3",
      replace: "Q4",
      revision_id: "rev-2",
    });

    const all = await calls();
    expect(all[3].body.requests.slice(0, 2)).toEqual([
      { deleteContentRange: { range: { endIndex: 10, startIndex: 1 } } },
      { insertText: { location: { index: 1 }, text: "New" } },
    ]);
    expect(all.slice(4).map((call) => call.operation)).toEqual([
      "google.drive.file.get",
      "google.drive.permissions.list",
      "google.docs.document.get",
      "google.docs.document.batchUpdate",
    ]);
    expect(all[7].body).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { matchCase: true, text: "Q3" },
            replaceText: "Q4",
            tabsCriteria: { tabIds: ["t.0"] },
          },
        },
      ],
      writeControl: { requiredRevisionId: "rev-2" },
    });
    expect(replaced).toMatchObject({ occurrences_changed: 3 });
  });

  it("creates a Doc, writes it, makes the requester the owner, and removes Junior's access", async () => {
    const { calls, run } = docTools([
      Response.json({ documentId: DOC_ID, revisionId: "rev-0", title: "Plan" }),
      Response.json({ documentId: DOC_ID, replies: [] }),
      Response.json({ id: "perm-owner", role: "owner" }),
      Response.json({ user: { permissionId: "perm-junior" } }),
      new Response(null, { status: 204 }),
    ]);

    const result = await run("createGoogleDoc", {
      content: "Hello",
      title: "Plan",
    });

    const [create, update, transfer, about, remove] = await calls();
    expect(create.url.toString()).toBe(
      "https://docs.googleapis.com/v1/documents",
    );
    expect(create.body).toEqual({ title: "Plan" });
    // Content goes in while Junior's account can still edit.
    expect(update.body.requests[0]).toEqual({
      insertText: { location: { index: 1 }, text: "Hello" },
    });
    expect(update.body.writeControl).toEqual({ requiredRevisionId: "rev-0" });
    expect(transfer.operation).toBe("google.drive.permission.create");
    expect(transfer.url.searchParams.get("transferOwnership")).toBe("true");
    // Google refuses an ownership transfer without the email.
    expect(transfer.url.searchParams.has("sendNotificationEmail")).toBe(false);
    expect(transfer.body).toEqual({
      emailAddress: REQUESTER,
      role: "owner",
      type: "user",
    });
    expect(about.operation).toBe("google.drive.about.get");
    expect(remove.operation).toBe("google.drive.permission.delete");
    expect(remove.url.pathname).toBe(
      `/drive/v3/files/${DOC_ID}/permissions/perm-junior`,
    );
    expect(result).toEqual({
      target: "createGoogleDoc",
      document_id: DOC_ID,
      title: "Plan",
      url: DOC_LINK,
    });
  });

  it("says a new Doc is not private when the hand-over fails", async () => {
    const created = () =>
      Response.json({ documentId: DOC_ID, revisionId: "rev-0", title: "Plan" });
    const forbidden = () =>
      Response.json({ error: { message: "Denied" } }, { status: 403 });

    // A Doc that was not handed over is deleted, so it never stays readable
    // through the shared account.
    const transferFailed = docTools([
      created(),
      forbidden(),
      new Response(null, { status: 204 }),
    ]);
    await expect(
      transferFailed.run("createGoogleDoc", { title: "Plan" }),
    ).rejects.toThrow(
      `Could not hand Google Doc "Plan" (${DOC_LINK}) to ${REQUESTER}: Google google.drive.permission.create failed with HTTP 403: Denied. The Doc was deleted.`,
    );
    const deleted = (await transferFailed.calls())[2];
    expect(deleted.operation).toBe("google.drive.file.delete");
    expect(deleted.url.pathname).toBe(`/drive/v3/files/${DOC_ID}`);

    const deleteFailed = docTools([
      created(),
      Response.json({ documentId: DOC_ID, replies: [] }),
      forbidden(),
      forbidden(),
    ]).run("createGoogleDoc", { content: "Secret", title: "Plan" });
    await expect(deleteFailed).rejects.toThrow(
      "The Doc could not be deleted either. Your own Google account still owns it, so it is not private",
    );

    const removeFailed = docTools([
      created(),
      Response.json({ id: "perm-owner" }),
      Response.json({ user: { permissionId: "perm-junior" } }),
      Response.json({ error: { message: "Not found" } }, { status: 404 }),
    ]).run("createGoogleDoc", { title: "Plan" });
    await expect(removeFailed).rejects.toThrow(
      "could not remove your own Google account's access",
    );
    await expect(removeFailed).rejects.toThrow(
      `That account can still read and edit the Doc, so it is not private. The requester can remove ${ACCOUNT_EMAIL}`,
    );
  });

  it("refuses an edit Junior's account or the requester cannot make, or of a Doc that changed", async () => {
    const { calls, run } = docTools([
      driveFile(false),
      driveFile(),
      permissions(
        { emailAddress: "eng@example.com", role: "writer", type: "group" },
        { emailAddress: REQUESTER, role: "commenter", type: "user" },
      ),
      driveFile(),
      permissions({ emailAddress: REQUESTER, role: "writer", type: "user" }),
      docBody("Someone else's edit\n"),
    ]);
    const input = {
      document: DOC_ID,
      find: "a",
      replace: "b",
      revision_id: "rev-1",
    };

    const readOnly = run("replaceGoogleDocText", input);
    await expect(readOnly).rejects.toThrow(PluginToolInputError);
    await expect(readOnly).rejects.toThrow(
      `Your Google account (${ACCOUNT_EMAIL}) cannot edit "Rethinking"`,
    );
    await expect(run("replaceGoogleDocText", input)).rejects.toThrow(
      `${REQUESTER} is not an editor`,
    );
    // The Doc is at rev-1 now, so an edit planned from rev-0 is refused.
    await expect(
      run("replaceGoogleDocContent", {
        content: "New",
        document: DOC_ID,
        revision_id: "rev-0",
      }),
    ).rejects.toThrow('"Rethinking" changed after you read it');
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
