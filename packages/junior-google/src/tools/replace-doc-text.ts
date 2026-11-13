import {
  definePluginTool,
  pluginToolDefinition,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  batchUpdateDoc,
  docOutputFields,
  docReferenceSchema,
  requireEditableDoc,
  requireRevision,
  revisionAfterUpdate,
  revisionIdSchema,
} from "./doc-edits";
import { googleFileRequest } from "./files";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    document: docReferenceSchema,
    revision_id: revisionIdSchema,
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

const tabsSchema = z.object({
  revisionId: z.string(),
  tabs: z
    .array(z.object({ tabProperties: z.object({ tabId: z.string() }) }))
    .default([]),
});

export const replaceGoogleDocTextToolDefinition = pluginToolDefinition({
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
    "Replace every match of a text in a Google Doc, as your own Google account. Matches keep their formatting. Only the first tab of a Doc with tabs is changed. Works only when that account and the requester can both edit the Doc. Anyone who can talk to you can read a Doc your account can edit, if they give you its link.",
  inputSchema,
  outputSchema,
});

/** Replace every match of a text in a Google Doc. */
export function createReplaceGoogleDocTextTool(ctx: GoogleToolContext) {
  return definePluginTool({
    ...replaceGoogleDocTextToolDefinition,
    async execute(input) {
      const doc = await requireEditableDoc(ctx, input.document);
      // Read the revision to check, and the first tab. Without tabsCriteria,
      // replaceAllText changes every tab. The other edit tools change only
      // the first tab, so this one does too.
      const { revisionId, tabs } = tabsSchema.parse(
        (
          await googleFileRequest(ctx, doc.ref, {
            operation: "google.docs.document.get",
            path: `/v1/documents/${doc.ref.fileId}`,
            query: {
              fields: "revisionId,tabs(tabProperties(tabId))",
              includeTabsContent: "true",
            },
          })
        ).body,
      );
      requireRevision(doc, revisionId, input.revision_id);
      const tabId = tabs[0]?.tabProperties.tabId;
      if (!tabId) {
        throw new PluginToolInputError(
          `Google did not return the tabs of "${doc.title}", so the text was not replaced.`,
        );
      }
      const reply = await batchUpdateDoc(
        ctx,
        doc.ref,
        [
          {
            replaceAllText: {
              containsText: { matchCase: input.match_case, text: input.find },
              replaceText: input.replace,
              tabsCriteria: { tabIds: [tabId] },
            },
          },
        ],
        input.revision_id,
      );
      const after = revisionAfterUpdate(reply);
      return {
        target: "replaceGoogleDocText" as const,
        document_id: doc.ref.fileId,
        occurrences_changed:
          replySchema.parse(reply).replies[0]?.replaceAllText
            ?.occurrencesChanged ?? 0,
        ...(after ? { revision_id: after } : undefined),
        title: doc.title,
        url: doc.url,
      };
    },
  });
}
