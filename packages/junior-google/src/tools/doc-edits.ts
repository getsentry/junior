/**
 * Shared steps for the tools that write Google Docs.
 *
 * Junior's account can edit every Doc shared with it as an editor, but anyone
 * who can talk to Junior could ask it to. So each edit also requires that the
 * requester can edit the Doc themselves.
 */
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { emailDomain } from "../config";
import { convertMarkdown, type ConvertedMarkdown } from "./doc-markdown";
import {
  fileReferenceSchema,
  googleFileRequest,
  parseFileReference,
  readGoogleFile,
  type FileReference,
} from "./files";
import { requesterEmail, type GoogleToolContext } from "./shared";

/** Longest Markdown that one edit accepts. */
const MAX_WRITE_CHARS = 100_000;

export const docReferenceSchema = fileReferenceSchema("Google Docs");

export const markdownContentSchema = z
  .string()
  .min(1)
  .max(MAX_WRITE_CHARS)
  .describe(
    "Markdown to write. Supports # headings, paragraphs, - and 1. lists (indent to nest), **bold**, *italic*, `code`, ``` code blocks, and [links](https://example.com). Tables and images are written as plain text.",
  );

/** Output fields shared by the tools that write one Doc. */
export const docOutputFields = {
  document_id: z.string(),
  revision_id: z
    .string()
    .optional()
    .describe(
      "Revision after this edit. Pass it as revision_id to edit the Doc again without reading it first.",
    ),
  title: z.string(),
  url: z.string(),
};

/** The revision of the Doc that the agent read, required by each edit. */
export const revisionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "revision_id from readGoogleDoc, or from your last edit of this Doc. The edit is refused if someone changed the Doc after that.",
  );

/**
 * Refuse an edit when the Doc changed after the agent read it.
 *
 * The agent plans an edit from the text it read. If the Doc changed since,
 * the edit can delete or rewrite text that the agent never saw.
 */
export function requireRevision(
  doc: { title: string },
  current: string,
  expected: string,
): void {
  if (current !== expected) {
    throw new PluginToolInputError(
      `"${doc.title}" changed after you read it. Read it again with readGoogleDoc, check that the edit still fits, and retry with the new revision_id.`,
    );
  }
}

/** Return the editor link of a Doc. */
export function docUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

const EDIT_ROLES = new Set(["owner", "organizer", "fileOrganizer", "writer"]);
// Stop after this many permission pages; a Doc rarely has more.
const MAX_PERMISSION_PAGES = 10;

const permissionsSchema = z.object({
  nextPageToken: z.string().optional(),
  permissions: z
    .array(
      z.object({
        domain: z.string().optional(),
        emailAddress: z.string().optional(),
        role: z.string(),
        type: z.string(),
      }),
    )
    .default([]),
});

/**
 * Require that the requester can edit the Doc through their own email, their
 * domain, or a link that anyone can edit. Group membership is not visible to
 * Junior's account, so a Doc shared only with a group is refused.
 */
async function requireRequesterCanEdit(
  ctx: GoogleToolContext,
  ref: FileReference,
): Promise<void> {
  const requester = await requesterEmail(ctx);
  if (!requester) {
    throw new PluginToolInputError(
      "The requester's email is unknown, so the tool cannot check that they may edit this Doc.",
    );
  }
  const domain = emailDomain(requester);
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PERMISSION_PAGES; page += 1) {
    const response = await googleFileRequest(ctx, ref, {
      operation: "google.drive.permissions.list",
      path: `/drive/v3/files/${ref.fileId}/permissions`,
      query: {
        fields: "nextPageToken,permissions(domain,emailAddress,role,type)",
        pageSize: "100",
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : undefined),
      },
    });
    const body = permissionsSchema.parse(response.body);
    const canEdit = body.permissions.some(
      (permission) =>
        EDIT_ROLES.has(permission.role) &&
        ((permission.type === "user" &&
          permission.emailAddress?.toLowerCase() === requester) ||
          (permission.type === "domain" &&
            permission.domain?.toLowerCase() === domain) ||
          permission.type === "anyone"),
    );
    if (canEdit) return;
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  throw new PluginToolInputError(
    `Only people who can edit this Doc can ask you to change it, and ${requester} is not an editor. Access through a Google group is not checked: the owner must share the Doc with ${requester} as an editor.`,
  );
}

// Elements also carry `startIndex`, so an image or a page break comes back as
// an element without `textRun` instead of being dropped.
const docParagraphSchema = z.object({
  elements: z
    .array(z.object({ textRun: z.object({ content: z.string() }).optional() }))
    .default([]),
});

const docSchema = z.object({
  body: z.object({
    content: z.array(
      z.object({
        endIndex: z.number(),
        paragraph: docParagraphSchema.optional(),
        startIndex: z.number().optional(),
      }),
    ),
  }),
  revisionId: z.string(),
});

type DocParagraph = z.infer<typeof docParagraphSchema>;

/** A Doc that the requester and Junior's account may both edit. */
interface EditableDoc {
  ref: FileReference;
  title: string;
  url: string;
}

/**
 * Check that Junior's account and the requester can both edit a Doc. Only the
 * first tab of a Doc with tabs is edited.
 */
export async function requireEditableDoc(
  ctx: GoogleToolContext,
  document: string,
): Promise<EditableDoc> {
  const ref = parseFileReference(document);
  const file = await readGoogleFile(ctx, ref, ["document"]);
  if (file.capabilities?.canEdit !== true) {
    throw new PluginToolInputError(
      `Your Google account (${ctx.accountEmail}) cannot edit "${file.name}". Ask the owner to share it with that account as an editor.`,
    );
  }
  await requireRequesterCanEdit(ctx, ref);
  return {
    ref,
    title: file.name,
    url: file.webViewLink ?? docUrl(ref.fileId),
  };
}

/** Read the body layout that index-based edits need. */
export async function readDocBody(
  ctx: GoogleToolContext,
  ref: FileReference,
): Promise<{
  /** Index after the last character of the body, as Docs counts it. */
  endIndex: number;
  /** Undefined when the body starts with a table or another non-paragraph. */
  first: DocParagraph | undefined;
  last: DocParagraph | undefined;
  revisionId: string;
}> {
  const response = await googleFileRequest(ctx, ref, {
    operation: "google.docs.document.get",
    path: `/v1/documents/${ref.fileId}`,
    query: {
      fields:
        "revisionId,body(content(endIndex,startIndex,paragraph(elements(startIndex,textRun(content)))))",
    },
  });
  const doc = docSchema.parse(response.body);
  const content = doc.body.content;
  return {
    endIndex: content.at(-1)?.endIndex ?? 1,
    // The section break before index 1 has no start index.
    first: content.find((element) => element.startIndex === 1)?.paragraph,
    last: content.at(-1)?.paragraph,
    revisionId: doc.revisionId,
  };
}

/**
 * True when a paragraph holds only its final newline. A paragraph with an
 * image or another non-text element is not empty.
 */
export function isEmptyParagraph(paragraph: DocParagraph | undefined): boolean {
  return (
    paragraph !== undefined &&
    paragraph.elements.every((element) => element.textRun) &&
    paragraph.elements
      .map((element) => element.textRun?.content ?? "")
      .join("") === "\n"
  );
}

/** Convert tool Markdown, and refuse Markdown that writes no text. */
export function convertDocMarkdown(markdown: string): ConvertedMarkdown {
  const converted = convertMarkdown(markdown);
  if (!converted.text.trim()) {
    throw new PluginToolInputError("content has no text to write.");
  }
  return converted;
}

const LINK_COLOR = {
  color: { rgbColor: { blue: 0.8, green: 0.33, red: 0.07 } },
};
const CODE_FONT = { fontFamily: "Roboto Mono" };
// Text styles that inserted text can inherit from the text next to it.
const RESET_TEXT_FIELDS =
  "backgroundColor,bold,fontSize,foregroundColor,italic,link,strikethrough,underline,weightedFontFamily";

/**
 * Build the Docs requests that insert converted Markdown at one index.
 *
 * Inserted text inherits the style and list of the paragraph it lands in, so
 * the requests reset those. `prefix` and `suffix` are newlines that
 * split the content from the paragraphs around it. List requests come last,
 * from the end back: they remove the leading tabs that set nesting, which
 * moves every later index.
 */
export function insertMarkdownRequests(
  converted: ConvertedMarkdown,
  input: {
    index: number;
    prefix: "" | "\n";
    suffix: "" | "\n";
  },
): unknown[] {
  const base = input.index + input.prefix.length;
  const range = (start: number, end: number) => ({
    endIndex: base + end,
    startIndex: base + start,
  });
  // Each paragraph ends with a newline right after its text, so a paragraph
  // range of end + 1 is never empty.
  const requests: unknown[] = [
    {
      insertText: {
        location: { index: input.index },
        text: `${input.prefix}${converted.text}${input.suffix}`,
      },
    },
  ];
  if (converted.text) {
    requests.push({
      updateTextStyle: {
        fields: RESET_TEXT_FIELDS,
        range: range(0, converted.text.length),
        textStyle: {},
      },
    });
  }
  for (const paragraph of converted.paragraphs) {
    requests.push({
      updateParagraphStyle: {
        fields: "namedStyleType",
        paragraphStyle: { namedStyleType: paragraph.style },
        range: range(paragraph.start, paragraph.end + 1),
      },
    });
  }
  for (const style of converted.textStyles) {
    const textStyle = {
      ...(style.bold && { bold: true }),
      ...(style.italic && { italic: true }),
      ...(style.code && { weightedFontFamily: CODE_FONT }),
      ...(style.link && {
        foregroundColor: LINK_COLOR,
        link: { url: style.link },
        underline: true,
      }),
    };
    requests.push({
      updateTextStyle: {
        fields: Object.keys(textStyle).join(","),
        range: range(style.start, style.end),
        textStyle,
      },
    });
  }
  requests.push({
    deleteParagraphBullets: { range: range(0, converted.text.length + 1) },
  });
  for (const list of [...converted.lists].reverse()) {
    requests.push({
      createParagraphBullets: {
        bulletPreset: list.ordered
          ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : "BULLET_DISC_CIRCLE_SQUARE",
        range: range(list.start, list.end + 1),
      },
    });
  }
  return requests;
}

const batchUpdateReplySchema = z.object({
  writeControl: z
    .object({ requiredRevisionId: z.string().optional() })
    .optional(),
});

/** Return the revision of a Doc after a batch update, when Google sends it. */
export function revisionAfterUpdate(body: unknown): string | undefined {
  return batchUpdateReplySchema.safeParse(body).data?.writeControl
    ?.requiredRevisionId;
}

/**
 * Apply Docs requests. A known revision makes Google refuse the edit when
 * someone changed the Doc after it was read, so the edit never lands on text
 * that the agent did not see.
 */
export async function batchUpdateDoc(
  ctx: GoogleToolContext,
  ref: FileReference,
  requests: unknown[],
  revisionId?: string,
): Promise<unknown> {
  const response = await googleFileRequest(ctx, ref, {
    body: {
      requests,
      ...(revisionId && { writeControl: { requiredRevisionId: revisionId } }),
    },
    operation: "google.docs.document.batchUpdate",
    path: `/v1/documents/${ref.fileId}:batchUpdate`,
  });
  return response.body;
}
