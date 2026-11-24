import { definePluginTool } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  describeVideo,
  videoIdSchema,
  videoOutputSchema,
  VIMEO_OPERATIONS,
  vimeoClient,
} from "../tool-support/vimeo-api.js";

/** Read a Vimeo video's processing state and embed URL. */
export const vimeoStatusTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Get the processing state, privacy, and embed URL of a Vimeo video. `ready` is true when Vimeo finished transcoding and the embed plays.",
  inputSchema: z.object({ video_id: videoIdSchema }).strict(),
  outputSchema: videoOutputSchema,
  async execute(input, options, ctx) {
    const client = vimeoClient(
      ctx.egress,
      VIMEO_OPERATIONS.status,
      options.signal,
    );
    return describeVideo(await client.getVideo(input.video_id));
  },
});
