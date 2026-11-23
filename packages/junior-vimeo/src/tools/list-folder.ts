import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  describeVideo,
  folderPageSchema,
  folderUriSchema,
  PAGE_SIZE,
  resolveFolder,
  VIDEO_FIELDS,
  videoFields,
  VIMEO_OPERATIONS,
  vimeoClient,
} from "../tool-support/vimeo-api.js";

/** List the videos in a Vimeo folder. */
export const vimeoListFolderTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "List the videos in a Vimeo folder, newest first, 100 per page, with each video's title, ID, embed URL, and processing state. Use it to find an existing video by title.",
  inputSchema: z
    .object({
      folder_uri: folderUriSchema.optional(),
      page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(1)
        .describe("Page number. Default 1."),
    })
    .strict(),
  outputSchema: pluginToolOutputSchema.extend({
    folder_uri: z.string(),
    videos: z.array(z.object(videoFields)).max(PAGE_SIZE),
    next_page: z.number().optional(),
  }),
  async execute(input, options, ctx) {
    const folder = resolveFolder(input.folder_uri);
    const client = vimeoClient(
      ctx.egress,
      VIMEO_OPERATIONS.listFolder,
      options.signal,
    );
    const result = folderPageSchema.parse(
      await client.api(
        "GET",
        `${folder.uri}/videos?fields=${VIDEO_FIELDS}&per_page=${PAGE_SIZE}&page=${input.page}&sort=date&direction=desc`,
      ),
    );
    return {
      folder_uri: folder.uri,
      videos: result.data.map(describeVideo),
      next_page: result.paging?.next ? input.page + 1 : undefined,
    };
  },
});
