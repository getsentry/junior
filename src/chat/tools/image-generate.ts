import { gateway } from "@ai-sdk/gateway";
import { tool } from "ai";
import { z } from "zod";
import { generateTextWithTelemetry } from "@/chat/ai";
import type { ToolHooks } from "@/chat/tools/types";

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}

export function createImageGenerateTool(hooks: ToolHooks) {
  return tool({
    description: "Generate an image using AI Gateway (Gemini 3 Pro Image).",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe("Image generation prompt describing the desired visual output.")
    }),
    execute: async ({ prompt }) => {
      try {
        const result = await generateTextWithTelemetry(
          {
            model: gateway("google/gemini-3-pro-image"),
            prompt
          },
          {
            functionId: "image_generate",
            metadata: {
              modelId: "google/gemini-3-pro-image",
              toolName: "image_generate"
            }
          }
        );

        const uploads = result.files
          .filter((file) => file.mediaType.startsWith("image/"))
          .map((file, index) => {
            const extension = extensionForMediaType(file.mediaType);
            const filename = `generated-image-${Date.now()}-${index + 1}.${extension}`;
            return {
              data: Buffer.from(file.uint8Array),
              filename,
              mimeType: file.mediaType
            };
          });

        if (uploads.length > 0) {
          hooks.onGeneratedFiles?.(uploads);
        }

        return {
          ok: true,
          model: "google/gemini-3-pro-image",
          prompt,
          image_count: uploads.length,
          images: uploads.map((upload) => ({
            filename: upload.filename,
            media_type: upload.mimeType,
            bytes: Buffer.isBuffer(upload.data) ? upload.data.byteLength : 0
          })),
          delivery: "Images will be attached to the Slack response as files."
        };
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "image generation failed");
      }
    }
  });
}
