import * as z from "zod";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ViewImageToolDeps } from "@/chat/tool-support/types";
import { readSandboxImage } from "@/chat/sandbox/image-files";
import { fitModelImage } from "@/chat/images/model-fit";

const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024;

const viewImageInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Path to an image file in the sandbox workspace."),
  })
  .strict();

/**
 * Create a tool that loads a sandbox image into the active model context.
 *
 * @runBuilt viewImage
 */
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
      "View an image file from the sandbox workspace when visual inspection is needed. Supports PNG, JPEG, GIF, and WebP images up to 5 MB.",
    exposure: "direct",
    inputSchema: viewImageInputSchema,
    async execute({ path }) {
      if (!supportsImageInput()) {
        throw new ToolInputError(
          "viewImage is unavailable because the current model does not support image inputs. No change to the call can fix this in this Turn.",
        );
      }

      const image = await readSandboxImage(
        path,
        deps.readFile ??
          ((targetPath) => sandbox.readFileToBuffer({ path: targetPath })),
        MAX_VIEW_IMAGE_BYTES,
      );

      const fitted = await fitModelImage({
        type: "image",
        data: image.data.toString("base64"),
        mimeType: image.mimeType,
      });
      const { scaled } = fitted;
      return {
        content: [
          ...(scaled
            ? [
                {
                  type: "text" as const,
                  text: `Scaled from ${scaled.from.join("x")} to ${scaled.to.join("x")} px to fit model image limits. Pixel coordinates refer to the scaled image.`,
                },
              ]
            : []),
          fitted.image,
        ],
      };
    },
  });
}
