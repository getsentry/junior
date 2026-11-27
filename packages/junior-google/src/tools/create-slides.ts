import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { newEditableFile } from "../drive/editable-file";
import { googleFileRequest } from "../drive/files";
import {
  googleApiError,
  googleApiRequest,
  requesterEmail,
  requireAllowedEmails,
  type GoogleToolContext,
} from "../google-api";
import { presentationUrl } from "../slides/presentation";

const inputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).describe("Presentation title."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("createGoogleSlides"),
  presentation_id: z.string(),
  title: z.string(),
  url: z.string(),
});

const createdSchema = z.object({
  presentationId: z.string(),
  title: z.string(),
});

/**
 * Create a Google Slides presentation and make the requester its owner.
 *
 * Unlike a new Doc, a deck takes many edits and layout checks, so Junior's
 * account stays an editor after the hand-over. That access lets nobody else
 * read or change the deck through Junior: the Slides read and edit tools
 * also check that the requester can open or edit it themselves.
 */
export const createGoogleSlidesTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Create a Google Slides presentation and hand it to the requester: they become the owner, and Google emails them about it. Your own Google account stays an editor, so build the deck next with readGoogleSlidesLayout, updateGoogleSlides, and getGoogleSlideThumbnail. A new deck has one title slide with empty placeholders. The requester can remove your account in the deck's sharing settings. Only works for requesters in the same Google Workspace organization as that account.",
  inputSchema,
  outputSchema,
  async execute(input, _options, ctx: GoogleToolContext) {
    const requester = await requesterEmail(ctx);
    if (!requester) {
      throw new PluginToolInputError(
        "The requester's email is unknown, so the presentation cannot be handed to them. No change to the call can fix this.",
      );
    }
    requireAllowedEmails([requester], ctx.allowedDomains);

    // Google ignores every field but the title and adds one title slide.
    const response = await googleApiRequest(ctx, {
      body: { title: input.title },
      operation: "google.slides.presentation.create",
      path: "/v1/presentations",
      query: { fields: "presentationId,title" },
    });
    if (response.status !== 200) {
      throw googleApiError("google.slides.presentation.create", response);
    }
    const created = createdSchema.parse(response.body);
    const ref = { fileId: created.presentationId };
    const file = newEditableFile(ref, created.title);
    const url = presentationUrl(created.presentationId);

    try {
      // Google requires the email for an ownership transfer. Junior's
      // account becomes a writer.
      await googleFileRequest(ctx, ref, {
        body: { emailAddress: requester, role: "owner", type: "user" },
        editable: file,
        operation: "google.drive.permission.create",
        path: `/drive/v3/files/${ref.fileId}/permissions`,
        query: { supportsAllDrives: "true", transferOwnership: "true" },
      });
    } catch (error) {
      // No person owns a deck that was not handed over. Delete it.
      const deleted = await googleApiRequest(ctx, {
        editable: file,
        operation: "google.drive.file.delete",
        path: `/drive/v3/files/${ref.fileId}`,
        query: { supportsAllDrives: "true" },
      }).then(
        (removed) => removed.status === 204 || removed.status === 200,
        () => false,
      );
      const failed = `Could not hand Google Slides presentation "${created.title}" (${url}) to ${requester}: ${error instanceof Error ? error.message : String(error)}.`;
      throw new Error(
        deleted
          ? `${failed} The presentation was deleted.`
          : `${failed} The presentation could not be deleted either. Your own Google account still owns it; delete it from that account's Drive.`,
        { cause: error },
      );
    }

    return {
      target: "createGoogleSlides" as const,
      presentation_id: created.presentationId,
      title: created.title,
      url,
    };
  },
});
