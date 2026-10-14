import { z } from "zod";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ViewImageToolDeps } from "@/chat/tools/types";
import { readSandboxImage } from "@/chat/tools/sandbox/image-files";

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
      "View an image file from the sandbox workspace when visual inspection is needed. Supports PNG, JPEG, GIF, and WebP images up to 5 MB.",
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
      );

      return {
        content: [
          {
            type: "image" as const,
            data: image.data.toString("base64"),
            mimeType: image.mimeType,
          },
        ],
      };
    },
  });
}
