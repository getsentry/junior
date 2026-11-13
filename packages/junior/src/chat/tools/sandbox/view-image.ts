import * as z from "zod";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ViewImageToolDeps } from "@/chat/tools/types";
import {
  readSandboxImage,
  shrinkImage,
} from "@/chat/tools/sandbox/image-files";

// Bigger images are resized, so this limit only bounds the memory of one read.
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
// Anthropic rejects every image with a side over 3000 px once a request has
// more than 20 images, and earlier tool results count. 2000 px stays under
// that limit for the whole Conversation.
const MAX_MODEL_IMAGE_EDGE = 2000;
// Bedrock and Google-managed Vertex reject images over 5 MB of base64. Base64
// is 4/3 of the raw size, so 3,750,000 raw bytes is 5,000,000 base64 chars.
const MAX_MODEL_IMAGE_BYTES = 3_750_000;
// Longest edges to try when an image must be resized, largest first.
const RESIZE_LONGEST_EDGES = [MAX_MODEL_IMAGE_EDGE, 1536, 1024, 768];

const viewImageInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Path to an image file in the sandbox workspace."),
  })
  .strict();

/** Create a tool that loads a sandbox image into the active model context. */
export function createViewImageTool(
  sandbox: SandboxWorkspace,
  supportsImageInput: () => boolean,
  deps: ViewImageToolDeps = {},
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "View an image file from the sandbox workspace when visual inspection is needed. Supports PNG, JPEG, GIF, and WebP images up to 25 MB. Images over 2000 px on a side or over 3.75 MB come back scaled down.",
    exposure: "direct",
    inputSchema: viewImageInputSchema,
    async execute({ path }) {
      if (!supportsImageInput()) {
        throw new ToolInputError(
          "viewImage is unavailable because the current model does not support image inputs",
        );
      }

      const image = await readSandboxImage(
        path,
        deps.readFile ??
          ((targetPath) => sandbox.readFileToBuffer({ path: targetPath })),
        MAX_SOURCE_IMAGE_BYTES,
      );
      // sharp loads a native library, so load it only when an image is viewed.
      const { default: sharp } = await import("sharp");
      const { width, height } = await sharp(image.data)
        .metadata()
        .catch(() => {
          throw new ToolInputError(
            `not a readable image: ${path} has an image signature, but its data cannot be decoded`,
          );
        });
      if (
        Math.max(width, height) <= MAX_MODEL_IMAGE_EDGE &&
        image.data.byteLength <= MAX_MODEL_IMAGE_BYTES
      ) {
        return {
          content: [
            {
              type: "image" as const,
              data: image.data.toString("base64"),
              mimeType: image.mimeType,
            },
          ],
        };
      }

      const smaller = await shrinkImage(
        image.data,
        RESIZE_LONGEST_EDGES,
        MAX_MODEL_IMAGE_BYTES,
      );
      if (!smaller) {
        throw new ToolInputError(
          `could not resize ${path} below ${MAX_MODEL_IMAGE_BYTES} bytes. Crop the image or make it smaller first.`,
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Resized from ${width}x${height} to ${smaller.width}x${smaller.height} px to fit model image limits.`,
          },
          {
            type: "image" as const,
            data: smaller.data.toString("base64"),
            mimeType: smaller.mimeType,
          },
        ],
      };
    },
  });
}
