import { definePluginTool } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { readVideo, tusUpload } from "../tool-support/media.js";
import {
  describeVideo,
  embedDomainSchema,
  MAX_EMBED_DOMAINS,
  resolveEmbedDomains,
  sandboxPathSchema,
  uploadAttemptSchema,
  videoIdFromUri,
  videoOutputSchema,
  VIMEO_OPERATIONS,
  vimeoClient,
  type VimeoSettings,
} from "../tool-support/vimeo-api.js";

/** Upload a sandbox video into a Vimeo folder as a private video. */
export function vimeoUploadTool(settings: VimeoSettings) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Upload a video file from the sandbox into the install's Vimeo folder as a private video: hidden from vimeo.com or unlisted, embeddable only on allowed domains, not downloadable. Returns the video ID, the privacy hash for unlisted videos, and the embed URL once the bytes are sent; Vimeo finishes processing later. Each call creates a new video. To change the file of an existing video, use vimeo_replaceFile.",
    // Review may see the raw input, before defaults apply.
    describeProposal: (input) =>
      `Upload ${input.path} to Vimeo as "${input.title}" (${input.view ?? "disable"}, embeds on ${(input.embed_domains ?? settings.embedDomains).join(", ") || "no domain"})`,
    inputSchema: z
      .object({
        path: sandboxPathSchema("MP4, MOV, or WebM file to upload"),
        title: z.string().trim().min(1).max(128).describe("Video title."),
        description: z
          .string()
          .trim()
          .max(5000)
          .describe("Video description. Omit for none.")
          .optional(),
        view: z
          .enum(["disable", "unlisted"])
          .default("disable")
          .describe(
            "Who can watch on vimeo.com. `disable` (default) hides the video from vimeo.com, so it plays only in embeds. `unlisted` also gives a vimeo.com link for anyone who has it.",
          ),
        embed_domains: z
          .array(embedDomainSchema)
          .min(1)
          .max(MAX_EMBED_DOMAINS)
          .describe(
            "Hostnames where the video may be embedded. Omit to use the install's default domains.",
          )
          .optional(),
      })
      .strict(),
    outputSchema: videoOutputSchema.extend({
      bytes: z.number(),
      folder_uri: z.string(),
      status_error: z.string().optional(),
    }),
    async execute(input, options, ctx) {
      const { folder } = settings;
      const embedDomains = resolveEmbedDomains(input.embed_domains, settings);
      const bytes = await readVideo(input.path, ctx.sandbox);
      const signal = options.signal;
      const client = vimeoClient(ctx.egress, VIMEO_OPERATIONS.upload, signal);
      // Team members upload to the team owner's account. Vimeo applies the
      // privacy settings when it creates the video, before any bytes arrive.
      const created = uploadAttemptSchema.parse(
        await client.api(
          "POST",
          `/users/${folder.owner}/videos?fields=uri,upload`,
          {
            name: input.title,
            description: input.description,
            folder_uri: folder.uri,
            upload: { approach: "tus", size: String(bytes.byteLength) },
            privacy: {
              view: input.view,
              embed: "whitelist",
              download: false,
              add: false,
              comments: "nobody",
            },
            embed_domains: embedDomains,
          },
        ),
      );
      const id = videoIdFromUri(created.uri ?? "");
      // From here the video exists, so every error names it.
      try {
        await tusUpload(created.upload.upload_link, bytes, signal);
      } catch (error) {
        throw new Error(
          `Vimeo video ${id} was created, but the upload did not finish: ${String(error)}`,
          { cause: error },
        );
      }
      const uploaded = { bytes: bytes.byteLength, folder_uri: folder.uri };
      // The bytes landed, so a failed lookup must not invite a second upload.
      try {
        return { ...describeVideo(await client.getVideo(id)), ...uploaded };
      } catch (error) {
        return {
          video_id: id,
          embed_url: `https://player.vimeo.com/video/${id}`,
          ready: false,
          ...uploaded,
          status_error: `The upload finished, but reading the video failed: ${String(error)}. Call vimeo_status for the hash and state; do not upload again.`,
        };
      }
    },
  });
}
