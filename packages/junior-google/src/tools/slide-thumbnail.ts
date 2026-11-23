import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { googleFileRequest, parseFileReference } from "../drive/files";
import { readRequesterFile } from "../drive/file-access";
import type { GoogleToolContext } from "../google-api";
import {
  presentationReferenceSchema,
  slideObjectIdSchema,
} from "../slides/presentation";

const inputSchema = z
  .object({
    presentation: presentationReferenceSchema,
    slide_object_id: slideObjectIdSchema,
    size: z
      .enum(["SMALL", "MEDIUM", "LARGE"])
      .default("MEDIUM")
      .describe("SMALL is 200 px wide, MEDIUM 800 px, LARGE 1600 px."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("getGoogleSlideThumbnail"),
  height: z.number(),
  path: z.string().describe("PNG of the slide in the sandbox."),
  width: z.number(),
});

const thumbnailSchema = z.object({
  contentUrl: z.string(),
  height: z.number(),
  width: z.number(),
});

// Google serves rendered thumbnails from this host. The URL needs no
// credential, so the sandbox downloads it and Junior's token stays on the
// host.
const THUMBNAIL_HOST_SUFFIX = ".googleusercontent.com";

/** Render one slide as a PNG that the agent can look at. */
export const getGoogleSlideThumbnailTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Render one slide of a Google Slides presentation as a PNG and look at it, as your own Google account sees it. Use it before and after layout edits to check overlap, overflow, and alignment. The PNG is also saved in the sandbox.",
  inputSchema,
  outputSchema,
  async execute(input, _options, ctx: GoogleToolContext) {
    const ref = parseFileReference(input.presentation);
    await readRequesterFile(ctx, ref, ["presentation"]);
    const response = await googleFileRequest(ctx, ref, {
      operation: "google.slides.page.thumbnail",
      path: `/v1/presentations/${ref.fileId}/pages/${input.slide_object_id}/thumbnail`,
      query: {
        "thumbnailProperties.mimeType": "PNG",
        "thumbnailProperties.thumbnailSize": input.size,
      },
    });
    const thumbnail = thumbnailSchema.parse(response.body);
    const url = URL.parse(thumbnail.contentUrl);
    if (
      url?.protocol !== "https:" ||
      !url.hostname.endsWith(THUMBNAIL_HOST_SUFFIX)
    ) {
      throw new Error(
        `Google returned a slide thumbnail outside ${THUMBNAIL_HOST_SUFFIX}.`,
      );
    }
    const directory = `${ctx.sandbox.root}/slides/${ref.fileId}`;
    const path = `${directory}/${input.slide_object_id.replace(/:/g, "_")}.png`;
    await ctx.sandbox.run({ args: ["-p", "--", directory], cmd: "mkdir" });
    const download = await ctx.sandbox.run({
      args: ["-fsS", "--max-time", "30", "-o", path, "--", url.href],
      cmd: "curl",
    });
    const image =
      download.exitCode === 0 ? await ctx.sandbox.readFile(path) : null;
    if (!image) {
      throw new Error(
        `Could not download the slide thumbnail: ${download.stderr.trim() || `curl exited with ${download.exitCode}`}`,
      );
    }
    const details = {
      target: "getGoogleSlideThumbnail" as const,
      height: thumbnail.height,
      path,
      width: thumbnail.width,
    };
    return {
      content: [
        { text: JSON.stringify(details), type: "text" as const },
        {
          data: Buffer.from(image).toString("base64"),
          mimeType: "image/png",
          type: "image" as const,
        },
      ],
      details,
    };
  },
});
