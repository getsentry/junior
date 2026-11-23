import path from "node:path";
import { definePluginTool } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { readVideo, tusUpload } from "../tool-support/media.js";
import {
  describeVideo,
  sandboxPathSchema,
  uploadAttemptSchema,
  videoIdSchema,
  videoOutputSchema,
  VIMEO_OPERATIONS,
  vimeoClient,
} from "../tool-support/vimeo-api.js";

/** Replace the file of an existing Vimeo video. */
export const vimeoReplaceFileTool = definePluginTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Replace the file of an existing Vimeo video with a new render from the sandbox. The video keeps its ID, hash, privacy, and embed domains, so links to it need no change. Vimeo processes the new file in the background.",
  describeProposal: (input) =>
    `Replace the file of Vimeo video ${input.video_id} with ${input.path}`,
  inputSchema: z
    .object({
      video_id: videoIdSchema,
      path: sandboxPathSchema("new MP4, MOV, or WebM file"),
    })
    .strict(),
  outputSchema: videoOutputSchema.extend({ bytes: z.number() }),
  async execute(input, options, ctx) {
    const bytes = await readVideo(input.path, ctx.sandbox);
    const signal = options.signal;
    const client = vimeoClient(
      ctx.egress,
      VIMEO_OPERATIONS.replaceFile,
      signal,
    );
    const attempt = uploadAttemptSchema.parse(
      await client.api(
        "POST",
        `/videos/${input.video_id}/versions?fields=upload`,
        {
          file_name: path.posix.basename(input.path),
          upload: {
            status: "in_progress",
            approach: "tus",
            size: String(bytes.byteLength),
          },
        },
      ),
    );
    await tusUpload(attempt.upload.upload_link, bytes, signal);
    return {
      ...describeVideo(await client.getVideo(input.video_id)),
      bytes: bytes.byteLength,
    };
  },
});
