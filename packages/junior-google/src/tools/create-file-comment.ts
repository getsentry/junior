import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  fileReferenceSchema,
  GOOGLE_FILE_TYPES,
  googleFileRequest,
  parseFileReference,
  readGoogleFile,
} from "./files";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    file: fileReferenceSchema("Google Docs, Sheets, or Slides"),
    content: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe("Plain-text comment to post as Junior's Google account."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("createGoogleFileComment"),
  commentId: z.string(),
  fileId: z.string(),
  title: z.string(),
  url: z.string().optional(),
});

const createdCommentSchema = z.object({ id: z.string() });

/**
 * Post one comment on a Google Doc, Sheet, or Slides file.
 *
 * The comment is on the whole file. The Drive API cannot attach it to text
 * in a Doc. Drive has no idempotency key for comments, so a retry can post a
 * second comment.
 */
export function createCreateGoogleFileCommentTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Post one comment on a Google Doc, Sheet, or Slides presentation, as Junior's own Google account. Everyone who can open the file sees the comment, and Google can email the file owner. The comment is on the whole file, not on a passage. Junior's account needs comment access to the file. Post only when the requester asks for a comment, and do not put private Slack details in it.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const ref = parseFileReference(input.file);
      // Check the type first: the drive scope can also comment on other Drive
      // files, such as PDFs.
      const file = await readGoogleFile(ctx, ref, GOOGLE_FILE_TYPES);
      const response = await googleFileRequest(ctx, ref, {
        body: { content: input.content },
        operation: "google.drive.comment.create",
        path: `/drive/v3/files/${ref.fileId}/comments`,
        query: { fields: "id" },
      });
      return {
        target: "createGoogleFileComment" as const,
        commentId: createdCommentSchema.parse(response.body).id,
        fileId: file.id,
        title: file.name,
        ...(file.webViewLink ? { url: file.webViewLink } : undefined),
      };
    },
  });
}
