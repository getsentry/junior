import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  batchUpdateDoc,
  docOutputFields,
  docReferenceSchema,
  requireEditableDoc,
} from "./doc-edits";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    document: docReferenceSchema,
    find: z
      .string()
      .min(1)
      .max(1000)
      .describe("Exact text to find. Markdown is not parsed."),
    replace: z
      .string()
      .max(10_000)
      .describe(
        "Plain text that replaces each match. Markdown is not parsed. An empty string deletes the matches.",
      ),
    match_case: z
      .boolean()
      .default(true)
      .describe("Match upper and lower case exactly."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("replaceGoogleDocText"),
  ...docOutputFields,
  occurrences_changed: z
    .number()
    .describe("Number of matches replaced. 0 means the text was not found."),
});

const replySchema = z.object({
  replies: z
    .array(
      z.object({
        replaceAllText: z
          .object({ occurrencesChanged: z.number().optional() })
          .optional(),
      }),
    )
    .default([]),
});

/** Replace every match of a text in a Google Doc. */
export function createReplaceGoogleDocTextTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal(input) {
      return `In Google Doc ${input.document}, replace every "${input.find}" with "${input.replace}".`;
    },
    description:
      "Replace every match of a text in a Google Doc, as your own Google account. Matches keep their formatting. Works only when that account and the requester can both edit the Doc. Anyone who can talk to you can read a Doc your account can edit, if they give you its link.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const doc = await requireEditableDoc(ctx, input.document);
      const body = replySchema.parse(
        await batchUpdateDoc(ctx, doc.ref, [
          {
            replaceAllText: {
              containsText: { matchCase: input.match_case, text: input.find },
              replaceText: input.replace,
            },
          },
        ]),
      );
      return {
        target: "replaceGoogleDocText" as const,
        document_id: doc.ref.fileId,
        occurrences_changed:
          body.replies[0]?.replaceAllText?.occurrencesChanged ?? 0,
        title: doc.title,
        url: doc.url,
      };
    },
  });
}
