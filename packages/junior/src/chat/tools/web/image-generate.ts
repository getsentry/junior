import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ImageGenerateToolDeps, ToolHooks } from "@/chat/tools/types";
import { botConfig } from "@/chat/config";
import { completeText, getGatewayApiKey } from "@/chat/pi/client";
import { JUNIOR_PERSONALITY } from "@/chat/prompt";
import { logInfo, logWarn } from "@/chat/logging";
import { generatedArtifactFileRefSchema } from "@/chat/tools/sandbox/file-uploads";
import { readSandboxImage } from "@/chat/tools/sandbox/image-files";
import type { InputImageType } from "@/chat/attachments/media";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

// AI Gateway rejects request bodies over 4.5 MB with HTTP 413. Base64 makes
// images a third larger, so 3 MB of images keeps the body under that limit.
const MAX_REQUEST_IMAGE_BYTES = 3 * 1024 * 1024;
// Bigger images are resized to fit the request, so this limit only bounds the
// memory that one read can use.
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
// Longest edges to try when an image must be resized, largest first.
const RESIZE_LONGEST_EDGES = [2048, 1536, 1024, 768];

type InputImage = { path: string; data: Buffer; mimeType: InputImageType };

const resizedImageSchema = z
  .object({
    path: z.string(),
    original_bytes: z.number().int().positive(),
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const imageGenerateOutputSchema = juniorToolOutputSchema
  .extend({
    model: z.string(),
    prompt: z.string(),
    enrichedPrompt: z.string(),
    image_count: z.number().int().nonnegative(),
    images: z.array(generatedArtifactFileRefSchema),
    delivery: z.string(),
    resized_images: z.array(resizedImageSchema).optional(),
    resize_notice: z.string().optional(),
  })
  .strict();

const ENRICHMENT_SYSTEM_PROMPT = `You are an image prompt enrichment agent. Your job is to rewrite image generation requests to reflect a specific visual identity and mood.

<personality>
${JUNIOR_PERSONALITY}
</personality>

Rewrite the user's image request into a detailed image generation prompt that encodes this personality's visual aesthetic. Output ONLY the rewritten prompt text — no explanation, no wrapper.`;

async function enrichImagePrompt(rawPrompt: string): Promise<string> {
  try {
    const { text } = await completeText({
      modelId: botConfig.fastModelId,
      system: ENRICHMENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: rawPrompt, timestamp: Date.now() }],
      maxTokens: 1024,
      promptName: "junior.image_prompt_enrichment",
    });
    if (text && text.trim().length > 0) {
      logInfo("image.prompt.enriched", {
        "app.image.enriched_prompt_length": text.trim().length,
      });
      return text.trim();
    }
    return rawPrompt;
  } catch (error) {
    logWarn("image.prompt.enrichment.failed", {
      "exception.message": String(error),
    });
    return rawPrompt;
  }
}

/** Resize and re-encode one image until it fits in `maxBytes`. */
async function shrinkImage(
  image: InputImage,
  maxBytes: number,
): Promise<{ image: InputImage; width: number; height: number }> {
  // sharp loads a native library, so load it only when an image is too big.
  const { default: sharp } = await import("sharp");
  const { hasAlpha } = await sharp(image.data).metadata();
  // JPEG is smallest for photos. WebP keeps transparency.
  const mimeType = hasAlpha ? "image/webp" : "image/jpeg";
  for (const edge of RESIZE_LONGEST_EDGES) {
    const resized = sharp(image.data).rotate().resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    });
    const { data, info } = await (
      hasAlpha ? resized.webp({ quality: 90 }) : resized.jpeg({ quality: 90 })
    ).toBuffer({ resolveWithObject: true });
    if (data.byteLength <= maxBytes) {
      return {
        image: { path: image.path, data, mimeType },
        width: info.width,
        height: info.height,
      };
    }
  }
  throw new ToolInputError(
    `could not resize ${image.path} below ${maxBytes} bytes. Use a smaller image.`,
  );
}

/** Resize input images that would push the request over the gateway limit. */
async function fitImagesToRequest(images: InputImage[]): Promise<{
  images: InputImage[];
  resized: z.infer<typeof resizedImageSchema>[];
}> {
  const totalBytes = images.reduce(
    (sum, image) => sum + image.data.byteLength,
    0,
  );
  if (totalBytes <= MAX_REQUEST_IMAGE_BYTES) {
    return { images, resized: [] };
  }
  // Fit the smallest images first. Bytes that small images do not use go to
  // the larger images, and the total never exceeds the limit.
  const fitted = [...images];
  const resized: z.infer<typeof resizedImageSchema>[] = [];
  let remainingBytes = MAX_REQUEST_IMAGE_BYTES;
  const bySize = images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => a.image.data.byteLength - b.image.data.byteLength);
  for (const [position, { image, index }] of bySize.entries()) {
    const share = Math.floor(remainingBytes / (bySize.length - position));
    if (image.data.byteLength <= share) {
      remainingBytes -= image.data.byteLength;
      continue;
    }
    const smaller = await shrinkImage(image, share);
    fitted[index] = smaller.image;
    remainingBytes -= smaller.image.data.byteLength;
    resized.push({
      path: image.path,
      original_bytes: image.data.byteLength,
      bytes: smaller.image.data.byteLength,
      width: smaller.width,
      height: smaller.height,
    });
  }
  return { images: fitted, resized };
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}

function parseImageGenerationError(
  status: number,
  body: string,
  model: string,
): string {
  if (!body) return `image generation failed: ${status}`;

  try {
    const payload = JSON.parse(body) as { error?: { message?: string } };
    const message = payload.error?.message?.trim();
    if (!message) return `image generation failed: ${status} ${body}`;
    if (message.includes("not an image model")) {
      return `image generation failed: configured model "${model}" is not an image generation model. Set AI_IMAGE_MODEL to a compatible image model.`;
    }
    return `image generation failed: ${status} ${message}`;
  } catch {
    return `image generation failed: ${status} ${body}`;
  }
}

/** Create the image tool with sandbox artifact guidance matched to file-send capability. */
export function createImageGenerateTool(
  hooks: Required<Pick<ToolHooks, "writeGeneratedArtifacts">>,
  options: {
    modelId: string;
    canSendFilesToActiveConversation?: boolean;
    sandbox: SandboxWorkspace;
  },
  deps: ImageGenerateToolDeps = {},
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Generate images from a prompt, or edit existing images. Use when the user wants to visually show or represent something — feelings, concepts, art, humor, or any visual idea. Also use for explicit image creation or image edit requests.",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          "Image generation prompt. When images are given, describe the change to make and what to keep.",
        ),
      images: z
        .array(z.string().min(1))
        .max(4)
        .optional()
        .describe(
          "Sandbox paths of PNG, JPEG, GIF, or WebP images to edit or use as references. Use paths from loadAttachment or from an earlier imageGenerate result. Images over 3 MB in total are resized.",
        ),
    }),
    outputSchema: imageGenerateOutputSchema,
    execute: async ({ prompt, images = [] }) => {
      const fetchImpl = deps.fetch ?? fetch;
      // Raw fetch does not resolve AI Gateway auth on its own, so this path
      // has to turn the shared gateway credential into a bearer token.
      const apiKey = await getGatewayApiKey();
      const model = options.modelId;
      const sourceImages = await Promise.all(
        images.map(async (path) => ({
          path,
          ...(await readSandboxImage(
            path,
            (targetPath) =>
              options.sandbox.readFileToBuffer({ path: targetPath }),
            MAX_SOURCE_IMAGE_BYTES,
          )),
        })),
      );
      const { images: inputImages, resized } =
        await fitImagesToRequest(sourceImages);
      const resizeResult =
        resized.length > 0
          ? {
              resized_images: resized,
              resize_notice:
                "Some input images were too large for the image model, so they were resized first. Tell the user which images were resized.",
            }
          : {};
      // Enrichment restyles the whole image, so it would undo an edit.
      const enrichedPrompt =
        inputImages.length > 0 ? prompt : await enrichImagePrompt(prompt);
      const content =
        inputImages.length > 0
          ? [
              { type: "text", text: enrichedPrompt },
              ...inputImages.map((image) => ({
                type: "image_url",
                image_url: {
                  url: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
                },
              })),
            ]
          : enrichedPrompt;
      const response = await fetchImpl(
        "https://ai-gateway.vercel.sh/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content }],
            modalities: ["image"],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          parseImageGenerationError(response.status, text, model),
        );
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
      const uploads: Array<{
        data: Buffer;
        filename: string;
        mimeType: string;
      }> = [];
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
          const fetched = await fetchImpl(url);
          if (!fetched.ok) continue;
          mimeType = fetched.headers.get("content-type") ?? mimeType;
          bytes = Buffer.from(await fetched.arrayBuffer());
        }

        if (!bytes) continue;
        const extension = extensionForMediaType(mimeType);
        uploads.push({
          data: bytes,
          filename: `generated-image-${Date.now()}-${index + 1}.${extension}`,
          mimeType,
        });
      }

      if (uploads.length > 0) {
        const artifactRefs = await hooks.writeGeneratedArtifacts(uploads);

        return {
          model,
          prompt,
          enrichedPrompt,
          image_count: artifactRefs.length,
          images: artifactRefs,
          ...resizeResult,
          delivery: options.canSendFilesToActiveConversation
            ? "Generated images were written to sandbox paths. To share them, pass the returned image objects unchanged as sendFiles files."
            : "Generated images were written to sandbox paths, but this runtime has no file-send tool for the active conversation.",
        };
      }

      return {
        model,
        prompt,
        enrichedPrompt,
        image_count: 0,
        images: [],
        ...resizeResult,
        delivery: "No images were generated.",
      };
    },
  });
}
