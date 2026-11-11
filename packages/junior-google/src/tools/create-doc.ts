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
  docUrl,
  insertMarkdownRequests,
  markdownContentSchema,
} from "./doc-edits";
import { googleFileRequest } from "./files";
import {
  googleApiError,
  googleApiRequest,
  requesterEmail,
  requireAllowedEmails,
  type GoogleToolContext,
} from "./shared";

const inputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).describe("Doc title."),
    content: markdownContentSchema.optional(),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("createGoogleDoc"),
  ...docOutputFields,
});

const createdSchema = z.object({
  documentId: z.string(),
  revisionId: z.string().optional(),
  title: z.string(),
});

/**
 * Create a Google Doc owned by Junior's account and share it with the
 * requester as an editor. Sharing with anyone else is left to the requester.
 *
 * Junior's account keeps the Doc, so the read tools can still find and read it
 * for anyone who talks to Junior, like any other file shared with that account.
 */
export function createCreateGoogleDocTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal(input) {
      return `Create Google Doc "${input.title}"${input.content ? ` with ${input.content.length} characters of content` : ""} and share it with the requester as an editor.`;
    },
    description:
      "Create a Google Doc owned by your own Google account, optionally with Markdown content, and share it with the requester as an editor. The Doc is not private: anyone who can talk to you can ask you to find and read it. Do not put content in it that other people who use you must not see.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const converted =
        input.content === undefined
          ? undefined
          : convertDocMarkdown(input.content);
      const requester = await requesterEmail(ctx);
      if (!requester) {
        throw new PluginToolInputError(
          "The requester's email is unknown, so the Doc cannot be shared with them.",
        );
      }
      requireAllowedEmails([requester], ctx.allowedDomains);

      const response = await googleApiRequest(ctx, {
        body: { title: input.title },
        operation: "google.docs.document.create",
        path: "/v1/documents",
      });
      if (response.status !== 200) {
        throw googleApiError("google.docs.document.create", response);
      }
      const created = createdSchema.parse(response.body);
      const ref = { fileId: created.documentId };
      // Share first, so the requester can open the Doc even when the content
      // write fails.
      await googleFileRequest(ctx, ref, {
        body: { emailAddress: requester, role: "writer", type: "user" },
        operation: "google.drive.permission.create",
        path: `/drive/v3/files/${ref.fileId}/permissions`,
        query: { sendNotificationEmail: "false", supportsAllDrives: "true" },
      });
      if (converted) {
        // A new Doc body is one empty paragraph that starts at index 1.
        await batchUpdateDoc(
          ctx,
          ref,
          insertMarkdownRequests(converted, {
            index: 1,
            prefix: "",
            suffix: "",
          }),
          created.revisionId,
        );
      }
      return {
        target: "createGoogleDoc" as const,
        document_id: created.documentId,
        title: created.title,
        url: docUrl(created.documentId),
      };
    },
  });
}
