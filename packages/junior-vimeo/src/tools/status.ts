import { definePluginTool } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  assertInFolder,
  describeVideo,
  videoIdSchema,
  videoOutputSchema,
  VIMEO_OPERATIONS,
  vimeoClient,
  type VimeoSettings,
} from "../tool-support/vimeo-api.js";

/** Read a Vimeo video's processing state and embed URL. */
export function vimeoStatusTool(settings: VimeoSettings) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Get the processing state, privacy, and embed URL of a Vimeo video in the install's folder. `ready` is true when Vimeo finished transcoding and the embed plays.",
    inputSchema: z.object({ video_id: videoIdSchema }).strict(),
    outputSchema: videoOutputSchema,
    async execute(input, options, ctx) {
      const client = vimeoClient(
        ctx.egress,
        VIMEO_OPERATIONS.status,
        options.signal,
      );
      const video = await client.getVideo(input.video_id);
      // One shared account can read other folders, unlisted hashes included.
      assertInFolder(video, settings);
      return describeVideo(video);
    },
  });
}
