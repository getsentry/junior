import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  type DocReference,
  docReferenceSchema,
  driveFileRequest,
  GOOGLE_DOC_MIME_TYPE,
  parseDocReference,
} from "./docs";
import type { GoogleToolContext } from "./shared";

/** Longest Doc text a tool result returns. */
const MAX_CONTENT_CHARS = 100_000;

const inputSchema = z
  .object({
    document: docReferenceSchema,
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("readGoogleDoc"),
  content: z.string().describe("Doc text as Markdown."),
  documentId: z.string(),
  modifiedTime: z.string().optional(),
  title: z.string(),
  truncated: z
    .boolean()
    .describe(
      `True when the Doc is longer than ${MAX_CONTENT_CHARS} characters and the end is left out.`,
    ),
  url: z.string().optional(),
});

const docFileSchema = z.object({
  id: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().optional(),
  name: z.string(),
  webViewLink: z.string().optional(),
});

/** Read the Drive metadata of one file, and require it to be a Google Doc. */
async function readDocFile(ctx: GoogleToolContext, doc: DocReference) {
  const response = await driveFileRequest(ctx, doc, {
    operation: "google.drive.file.get",
    path: `/drive/v3/files/${doc.fileId}`,
    query: {
      fields: "id,mimeType,modifiedTime,name,webViewLink",
      supportsAllDrives: "true",
    },
  });
  const file = docFileSchema.parse(response.body);
  if (file.mimeType !== GOOGLE_DOC_MIME_TYPE) {
    throw new PluginToolInputError(
      `"${file.name}" is not a Google Doc (${file.mimeType}). Junior can only read Google Docs.`,
    );
  }
  return file;
}

/**
 * Read one Google Doc as Markdown.
 *
 * Drive exports the Doc, so this needs no Docs API. Comments are not in the
 * export; `listGoogleDocComments` reads them.
 */
export function createReadGoogleDocTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Read the text of one Google Doc as Markdown, as Junior's own Google account sees it. Works for Docs shared with that account and Docs shared with anyone who has the link. Comments are not included; use listGoogleDocComments for them. Doc contents can be private: share only what the requester needs, and avoid repeating them in public channels.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const doc = parseDocReference(input.document);
      const file = await readDocFile(ctx, doc);
      const response = await driveFileRequest(ctx, doc, {
        headers: { Accept: "text/markdown" },
        operation: "google.drive.file.export",
        path: `/drive/v3/files/${doc.fileId}/export`,
        query: { mimeType: "text/markdown" },
      });
      const content = typeof response.body === "string" ? response.body : "";
      return {
        target: "readGoogleDoc" as const,
        content: content.slice(0, MAX_CONTENT_CHARS),
        documentId: file.id,
        ...(file.modifiedTime
          ? { modifiedTime: file.modifiedTime }
          : undefined),
        title: file.name,
        truncated: content.length > MAX_CONTENT_CHARS,
        ...(file.webViewLink ? { url: file.webViewLink } : undefined),
      };
    },
  });
}
