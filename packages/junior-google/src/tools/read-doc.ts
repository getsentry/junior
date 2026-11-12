import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  fileOutputFields,
  fileReferenceSchema,
  googleFileRequest,
  MAX_CONTENT_CHARS,
  parseFileReference,
  readGoogleFile,
  resourceKeyHeaders,
} from "./files";
import { googleApiRequest, type GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    document: fileReferenceSchema("Google Docs"),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("readGoogleDoc"),
  content: z.string().describe("Doc text as Markdown."),
  document_id: z.string(),
  revision_id: z
    .string()
    .optional()
    .describe(
      "Revision of the Doc that this content comes from. Pass it to the Doc edit tools, which refuse the edit if the Doc changed after this read. Missing when the Docs API is not available; then the Doc cannot be edited.",
    ),
  modified_at: z.string().optional(),
  title: z.string(),
  truncated: z
    .boolean()
    .describe(
      `True when the Doc is longer than ${MAX_CONTENT_CHARS} characters and the end is left out.`,
    ),
  url: z.string().optional(),
});

const revisionSchema = z.object({ revisionId: z.string() });

/**
 * Read one Google Doc as Markdown.
 *
 * Drive exports the text. The Docs API gives the revision that the edit tools
 * check. Comments are not in the export; `listGoogleFileComments` reads them.
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
      // Read the revision before the text. If the Doc changes in between, the
      // text is newer than the revision, and an edit is refused, not misplaced.
      // Reading needs only Drive. When the Docs API fails, for example before
      // an admin enables it, the text is still returned without a revision,
      // and the edit tools cannot run.
      const revision = await googleApiRequest(ctx, {
        headers: resourceKeyHeaders(ref),
        operation: "google.docs.document.get",
        path: `/v1/documents/${ref.fileId}`,
        query: { fields: "revisionId" },
      });
      const revisionId =
        revision.status === 200
          ? revisionSchema.safeParse(revision.body).data?.revisionId
          : undefined;
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
        document_id: file.id,
        ...(revisionId ? { revision_id: revisionId } : undefined),
        ...fileOutputFields(file),
        title: file.name,
        truncated: content.length > MAX_CONTENT_CHARS,
      };
    },
  });
}
