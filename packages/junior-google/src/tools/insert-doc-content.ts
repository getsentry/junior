import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  batchUpdateDoc,
  convertDocMarkdown,
  docOutputFields,
  docReferenceSchema,
  insertMarkdownRequests,
  isEmptyParagraph,
  markdownContentSchema,
  readDocBody,
  requireEditableDoc,
} from "./doc-edits";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    document: docReferenceSchema,
    content: markdownContentSchema,
    position: z
      .enum(["end", "start"])
      .default("end")
      .describe(
        "Add the content after the last paragraph, or before the first.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("insertGoogleDocContent"),
  ...docOutputFields,
});

/** Add Markdown content to the start or end of a Google Doc. */
export function createInsertGoogleDocContentTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal(input) {
      return `Add ${input.content.length} characters of content to the ${input.position} of Google Doc ${input.document}.`;
    },
    description:
      "Add Markdown content, such as a plan or an agenda, to the start or end of a Google Doc as your own Google account. Existing content stays. Works only when that account and the requester can both edit the Doc. Anyone who can talk to you can read a Doc your account can edit, if they give you its link.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const converted = convertDocMarkdown(input.content);
      const doc = await requireEditableDoc(ctx, input.document);
      const body = await readDocBody(ctx, doc.ref);
      if (input.position === "start" && !body.first) {
        throw new PluginToolInputError(
          `"${doc.title}" starts with a table, and Google Docs cannot add text before it. Use position "end" instead.`,
        );
      }
      const requests =
        input.position === "start"
          ? insertMarkdownRequests(converted, {
              index: 1,
              prefix: "",
              suffix: isEmptyParagraph(body.first) ? "" : "\n",
            })
          : insertMarkdownRequests(converted, {
              // Insert before the newline that ends the body.
              index: body.endIndex - 1,
              prefix: isEmptyParagraph(body.last) ? "" : "\n",
              suffix: "",
            });
      await batchUpdateDoc(ctx, doc.ref, requests, body.revisionId);
      return {
        target: "insertGoogleDocContent" as const,
        document_id: doc.ref.fileId,
        title: doc.title,
        url: doc.url,
      };
    },
  });
}
