import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ImageGenerateToolDeps, ToolHooks } from "@/chat/tools/types";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { generateImage, NoImageGeneratedError, type GeneratedFile } from "ai";
import { botConfig } from "@/chat/config";
import {
  completeText,
  MISSING_GATEWAY_CREDENTIALS_ERROR,
} from "@/chat/pi/client";
import { resolveGatewayCredential } from "@/chat/pi/gateway-auth";
import { JUNIOR_PERSONALITY } from "@/chat/prompt";
import { logInfo, logWarn } from "@/chat/logging";
import { generatedArtifactFileRefSchema } from "@/chat/tools/sandbox/file-uploads";
import { readSandboxImage } from "@/chat/tools/sandbox/image-files";
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

// The AI SDK reads the media type from the image bytes.
type InputImage = { path: string; data: Buffer };

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
        image: { path: image.path, data },
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
      // Use the shared resolver so OIDC wins over a leftover team API key.
      const credential = await resolveGatewayCredential();
      if (!credential) {
        throw new Error(MISSING_GATEWAY_CREDENTIALS_ERROR);
      }
      const gateway = createGatewayProvider({
        apiKey: credential.token,
        ...(deps.fetch ? { fetch: deps.fetch } : undefined),
      });
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
      let generatedImages: GeneratedFile[];
      try {
        ({ images: generatedImages } = await generateImage({
          model: gateway.imageModel(model),
          // Input images make this an edit of those images.
          prompt:
            inputImages.length > 0
              ? {
                  text: enrichedPrompt,
                  images: inputImages.map((image) => image.data),
                }
              : enrichedPrompt,
          n: 1,
        }));
      } catch (error) {
        if (NoImageGeneratedError.isInstance(error)) {
          generatedImages = [];
        } else if (
          error instanceof Error &&
          error.message.includes("not an image model")
        ) {
          // The model id comes from app config, so the agent cannot fix it.
          throw new Error(
            `image generation failed: configured model "${model}" is not an image generation model. Set AI_IMAGE_MODEL to an AI Gateway image model.`,
          );
        } else {
          throw error;
        }
      }
      const uploads = generatedImages.map((image, index) => ({
        data: Buffer.from(image.uint8Array),
        filename: `generated-image-${Date.now()}-${index + 1}.${extensionForMediaType(image.mediaType)}`,
        mimeType: image.mediaType,
      }));

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
