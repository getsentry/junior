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

const ownPermissionsSchema = z.object({
  permissions: z
    .array(z.object({ emailAddress: z.string().optional(), id: z.string() }))
    .default([]),
});

/**
 * Create a Google Doc, write its content, then hand it to the requester.
 *
 * Junior's account creates the Doc, so it is the owner at first. Any file
 * that account can open is readable through the read tools by anyone who
 * talks to Junior. So the tool makes the requester the owner and then removes
 * Junior's own access. Each failure after the create names the Doc and says
 * who can still open it, so a Doc is never reported private when it is not.
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
      return `Create Google Doc "${input.title}"${input.content ? ` with ${input.content.length} characters of content` : ""}, make the requester its owner (Google emails them), and remove your own access.`;
    },
    description:
      "Create a Google Doc with optional Markdown content and hand it to the requester: they become the owner, Google emails them about it, and your own Google account loses access. You cannot read or edit the Doc afterward unless the requester shares it with that account again. Only works for requesters in the same Google Workspace organization as that account.",
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
          "The requester's email is unknown, so the Doc cannot be handed to them.",
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
      const url = docUrl(created.documentId);
      const doc = `Google Doc "${created.title}" (${url})`;
      const reason = (error: unknown) =>
        error instanceof Error ? error.message : String(error);

      // Write before the hand-over, while Junior's account can still edit.
      if (converted) {
        try {
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
        } catch (error) {
          throw new Error(
            `Created ${doc}, but could not write its content: ${reason(error)}. The Doc is empty, your own Google account still owns it, and the requester has no access to it.`,
            { cause: error },
          );
        }
      }

      try {
        // Google requires the email for an ownership transfer. Junior's
        // account becomes a writer.
        await googleFileRequest(ctx, ref, {
          body: { emailAddress: requester, role: "owner", type: "user" },
          operation: "google.drive.permission.create",
          path: `/drive/v3/files/${ref.fileId}/permissions`,
          query: { supportsAllDrives: "true", transferOwnership: "true" },
        });
      } catch (error) {
        throw new Error(
          `Created ${doc}, but could not make ${requester} its owner: ${reason(error)}. Your own Google account still owns it, so the Doc is not private, and the requester has no access to it.`,
          { cause: error },
        );
      }

      try {
        const listed = await googleFileRequest(ctx, ref, {
          operation: "google.drive.permissions.list",
          path: `/drive/v3/files/${ref.fileId}/permissions`,
          query: {
            fields: "permissions(emailAddress,id)",
            supportsAllDrives: "true",
          },
        });
        const own = ownPermissionsSchema
          .parse(listed.body)
          .permissions.find(
            (permission) =>
              permission.emailAddress?.toLowerCase() === ctx.accountEmail,
          );
        if (own) {
          const removed = await googleApiRequest(ctx, {
            operation: "google.drive.permission.delete",
            path: `/drive/v3/files/${ref.fileId}/permissions/${own.id}`,
            query: { supportsAllDrives: "true" },
          });
          if (removed.status !== 204 && removed.status !== 200) {
            throw googleApiError("google.drive.permission.delete", removed);
          }
        }
      } catch (error) {
        throw new Error(
          `Made ${requester} the owner of ${doc}, but could not remove your own Google account's access: ${reason(error)}. That account can still read and edit the Doc, so it is not private. The requester can remove ${ctx.accountEmail} in the Doc's sharing settings.`,
          { cause: error },
        );
      }

      return {
        target: "createGoogleDoc" as const,
        document_id: created.documentId,
        title: created.title,
        url,
      };
    },
  });
}
