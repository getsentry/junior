import { z } from "zod";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ViewImageToolDeps } from "@/chat/tools/types";
import {
  normalizeSandboxPath,
  SandboxFileNotFoundError,
} from "@/chat/tools/sandbox/file-uploads";

const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024;

const viewImageInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Path to an image file in the sandbox workspace."),
  })
  .strict();

function detectImageMimeType(data: Buffer): string | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/** Create a tool that loads a sandbox image into the active model context. */
export function createViewImageTool(
  sandbox: SandboxWorkspace,
  supportsImageInput: () => boolean,
  deps: ViewImageToolDeps = {},
) {
  return zodTool({
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

      const targetPath = normalizeSandboxPath(path);
      const data = deps.readFile
        ? await deps.readFile(targetPath)
        : await sandbox.readFileToBuffer({ path: targetPath });
      if (!data) {
        throw new SandboxFileNotFoundError(targetPath);
      }
      if (data.byteLength === 0) {
        throw new ToolInputError(`image file is empty: ${targetPath}`);
      }
      if (data.byteLength > MAX_VIEW_IMAGE_BYTES) {
        throw new ToolInputError(
          `image exceeds ${MAX_VIEW_IMAGE_BYTES} bytes: ${targetPath} (${data.byteLength} bytes)`,
        );
      }

      const mimeType = detectImageMimeType(data);
      if (!mimeType) {
        throw new ToolInputError(
          `unsupported image format: ${targetPath}; use PNG, JPEG, GIF, or WebP`,
        );
      }

      return {
        content: [
          {
            type: "image" as const,
            data: data.toString("base64"),
            mimeType,
          },
        ],
      };
    },
  });
}
