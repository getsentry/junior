import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { getGatewayApiKey } from "@/chat/pi/client";
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
    description: "Generate an image from a prompt.",
    inputSchema: Type.Object({
      prompt: Type.String({
        minLength: 1,
        maxLength: 4000,
        description: "Image generation prompt."
      })
    }),
    execute: async ({ prompt }) => {
      const apiKey = getGatewayApiKey();
      if (!apiKey) {
        throw new Error("AI_GATEWAY_API_KEY is required for image generation");
      }

      const response = await fetch("https://ai-gateway.vercel.sh/v1/images/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "google/gemini-3-pro-image",
          prompt
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`image generation failed: ${response.status} ${text}`);
      }

      const payload = (await response.json()) as {
        data?: Array<{
          b64_json?: string;
          url?: string;
          mime_type?: string;
        }>;
      };
      const uploads: Array<{ data: Buffer; filename: string; mimeType: string }> = [];
      for (const [index, image] of (payload.data ?? []).entries()) {
        let bytes: Buffer | null = null;
        let mimeType = image.mime_type ?? "image/png";

        if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
          bytes = Buffer.from(image.b64_json, "base64");
        } else if (typeof image.url === "string" && image.url.length > 0) {
          const fetched = await fetch(image.url);
          if (!fetched.ok) continue;
          mimeType = fetched.headers.get("content-type") ?? mimeType;
          bytes = Buffer.from(await fetched.arrayBuffer());
        }

        if (!bytes) continue;
        const extension = extensionForMediaType(mimeType);
        uploads.push({
          data: bytes,
          filename: `generated-image-${Date.now()}-${index + 1}.${extension}`,
          mimeType
        });
      }

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
          bytes: upload.data.byteLength
        })),
        delivery: "Images will be attached to the Slack response as files."
      };
    }
  });
}
