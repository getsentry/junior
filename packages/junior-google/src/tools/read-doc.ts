import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  fileOutputFields,
  fileReferenceSchema,
  googleFileRequest,
  MAX_CONTENT_CHARS,
  parseFileReference,
  readGoogleFile,
} from "./files";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    document: fileReferenceSchema("Google Docs"),
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

/**
 * Read one Google Doc as Markdown.
 *
 * Drive exports the Doc, so this needs no Docs API. Comments are not in the
 * export; `listGoogleFileComments` reads them.
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
      "Read the text of one Google Doc as Markdown, as your own Google account sees it. Works for Docs shared with that account and Docs shared with anyone who has the link. Comments are not included; use listGoogleFileComments for them. Doc contents can be private: share only what the requester needs, and avoid repeating them in public channels.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const ref = parseFileReference(input.document);
      const file = await readGoogleFile(ctx, ref, ["document"]);
      const response = await googleFileRequest(ctx, ref, {
        headers: { Accept: "text/markdown" },
        operation: "google.drive.file.export",
        path: `/drive/v3/files/${ref.fileId}/export`,
        query: { mimeType: "text/markdown" },
      });
      const content = typeof response.body === "string" ? response.body : "";
      return {
        target: "readGoogleDoc" as const,
        content: content.slice(0, MAX_CONTENT_CHARS),
        documentId: file.id,
        ...fileOutputFields(file),
        title: file.name,
        truncated: content.length > MAX_CONTENT_CHARS,
      };
    },
  });
}
