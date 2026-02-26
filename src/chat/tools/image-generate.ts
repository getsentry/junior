import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import type { ToolHooks } from "@/chat/tools/types";

const DEFAULT_IMAGE_MODEL = "google/gemini-3-pro-image";

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}

function parseImageGenerationError(status: number, body: string, model: string): string {
  if (!body) return `image generation failed: ${status}`;

  try {
    const payload = JSON.parse(body) as { error?: { message?: string } };
    const message = payload.error?.message?.trim();
    if (!message) return `image generation failed: ${status} ${body}`;
    if (message.includes("not an image model")) {
      return `image generation failed: configured model "${model}" is not an image generation model. Set AI_IMAGE_MODEL to a compatible image model (for example "${DEFAULT_IMAGE_MODEL}").`;
    }
    return `image generation failed: ${status} ${message}`;
  } catch {
    return `image generation failed: ${status} ${body}`;
  }
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
      const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
      if (!apiKey) {
        throw new Error("Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
      }
      const model = process.env.AI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
      const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image"]
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(parseImageGenerationError(response.status, text, model));
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            images?: Array<{
              image_url?: {
                url?: string;
              };
            }>;
          };
        }>;
      };
      const uploads: Array<{ data: Buffer; filename: string; mimeType: string }> = [];
      const generatedImages = payload.choices?.[0]?.message?.images ?? [];
      for (const [index, image] of generatedImages.entries()) {
        let bytes: Buffer | null = null;
        let mimeType = "image/png";
        const url = image.image_url?.url;

        if (typeof url === "string" && url.startsWith("data:")) {
          const match = url.match(/^data:([^;,]+);base64,(.+)$/);
          if (!match) continue;
          mimeType = match[1] ?? mimeType;
          bytes = Buffer.from(match[2] ?? "", "base64");
        } else if (typeof url === "string" && url.length > 0) {
          const fetched = await fetch(url);
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
        model,
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
