import * as z from "zod";
import {
  googleFileRequest,
  MAX_CONTENT_CHARS,
  resourceKeyHeaders,
  type FileReference,
} from "./files";
import { googleApiRequest, type GoogleToolContext } from "./shared";

/** Output fields of `readGoogleFile` for a Doc. */
export const docOutputFields = {
  content: z
    .string()
    .optional()
    .describe("Doc text as Markdown. Only for Docs."),
  revision_id: z
    .string()
    .optional()
    .describe(
      "Revision of the Doc that this content comes from. Pass it to the Doc edit tools, which refuse the edit if the Doc changed after this read. Missing when the Docs API is not available; then the Doc cannot be edited.",
    ),
};

const revisionSchema = z.object({ revisionId: z.string() });

/**
 * Read one Google Doc as Markdown.
 *
 * Drive exports the text. The Docs API gives the revision that the edit tools
 * check. Comments are not in the export; `listGoogleFileComments` reads them.
 */
export async function readDocContent(
  ctx: GoogleToolContext,
  ref: FileReference,
) {
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
    content: content.slice(0, MAX_CONTENT_CHARS),
    ...(revisionId ? { revision_id: revisionId } : undefined),
    truncated: content.length > MAX_CONTENT_CHARS,
  };
}
