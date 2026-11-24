import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { imageType, readImage } from "../tool-support/media.js";
import {
  assertInFolder,
  sandboxPathSchema,
  videoIdSchema,
  VIMEO_OPERATIONS,
  vimeoClient,
  type VimeoSettings,
} from "../tool-support/vimeo-api.js";

const pictureSchema = z.object({
  uri: z.string(),
  link: z.string().url(),
  base_link: z.string().nullish(),
});

/** Set a Vimeo video's thumbnail from a sandbox image. */
export function vimeoSetThumbnailTool(settings: VimeoSettings) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Set the poster thumbnail of a video in the install's Vimeo folder from a JPEG or PNG in the sandbox. The new image replaces the active thumbnail.",
    describeProposal: (input) =>
      `Set the thumbnail of Vimeo video ${input.video_id} from ${input.path}`,
    inputSchema: z
      .object({
        video_id: videoIdSchema,
        path: sandboxPathSchema("JPEG or PNG poster image"),
      })
      .strict(),
    outputSchema: pluginToolOutputSchema.extend({
      video_id: z.string(),
      picture_uri: z.string(),
      thumbnail_url: z.string().optional(),
    }),
    async execute(input, options, ctx) {
      const bytes = await readImage(input.path, ctx.sandbox);
      const signal = options.signal;
      const client = vimeoClient(
        ctx.egress,
        VIMEO_OPERATIONS.setThumbnail,
        signal,
      );
      assertInFolder(await client.getVideo(input.video_id), settings);
      const picture = pictureSchema.parse(
        await client.api("POST", `/videos/${input.video_id}/pictures`),
      );
      // The picture link is a one-time upload URL that needs no token.
      const init: RequestInit = {
        method: "PUT",
        headers: { "Content-Type": imageType(bytes)! },
        body: new Uint8Array(bytes),
      };
      if (signal) init.signal = signal;
      const response = await fetch(picture.link, init);
      if (!response.ok) {
        throw new Error(
          `Vimeo thumbnail upload failed with HTTP ${response.status}`,
        );
      }
      const active = pictureSchema
        .partial({ link: true })
        .parse(await client.api("PATCH", picture.uri, { active: true }));
      return {
        video_id: input.video_id,
        picture_uri: picture.uri,
        thumbnail_url: active.base_link ?? picture.base_link ?? undefined,
      };
    },
  });
}
