import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  batchUpdateDoc,
  convertDocMarkdown,
  docOutputFields,
  docReferenceSchema,
  insertMarkdownRequests,
  markdownContentSchema,
  readDocBody,
  requireEditableDoc,
} from "./doc-edits";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    document: docReferenceSchema,
    content: markdownContentSchema,
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("replaceGoogleDocContent"),
  ...docOutputFields,
});

/** Replace the whole body of a Google Doc with Markdown content. */
export function createReplaceGoogleDocContentTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal(input) {
      return `Delete all of the body of Google Doc ${input.document} and replace it with ${input.content.length} characters of new content.`;
    },
    description:
      "Replace the whole body of a Google Doc with Markdown content, as your own Google account. Everything in the body is deleted, including tables, images, and text other people wrote; headers, footers, comments, and version history stay. Works only when that account and the requester can both edit the Doc. Anyone who can talk to you can read a Doc your account can edit, if they give you its link. Confirm with the requester first unless they asked to replace the whole Doc.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const converted = convertDocMarkdown(input.content);
      const doc = await requireEditableDoc(ctx, input.document);
      const body = await readDocBody(ctx, doc.ref);
      // The body starts at index 1, and its final newline cannot be deleted.
      const deleteEnd = body.endIndex - 1;
      await batchUpdateDoc(
        ctx,
        doc.ref,
        [
          ...(deleteEnd > 1
            ? [
                {
                  deleteContentRange: {
                    range: { endIndex: deleteEnd, startIndex: 1 },
                  },
                },
              ]
            : []),
          ...insertMarkdownRequests(converted, {
            index: 1,
            prefix: "",
            suffix: "",
          }),
        ],
        body.revisionId,
      );
      return {
        target: "replaceGoogleDocContent" as const,
        document_id: doc.ref.fileId,
        title: doc.title,
        url: doc.url,
      };
    },
  });
}
