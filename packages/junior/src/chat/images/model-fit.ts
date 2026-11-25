/**
 * Fit images to the limits of model providers. Claude rejects a request with
 * more than 20 images when an image has a side over 3000 px, and Bedrock and
 * Google-managed Vertex reject an image over 5 MB of base64. A rejected image
 * stays in history, so each later request in the Conversation fails too. See
 * "Request limits" in https://platform.claude.com/docs/en/build-with-claude/vision.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { logWarn } from "@/chat/logging";
import { readImageDimensions } from "@/chat/services/image-dimensions";
import { claudeMaxImageSize } from "@/chat/services/token-estimate";

const MAX_IMAGE_BASE64_CHARS = 5_000_000;

/** An image that fits model limits, and its old and new size when it was scaled. */
export interface FittedModelImage {
  image: ImageContent;
  scaled?: { from: [number, number]; to: [number, number] };
}

type SharpImage = import("sharp").Sharp;

// PNG and GIF images are often screenshots, so they stay lossless. A lossy
// image keeps its format.
function encodeLike(mimeType: string, image: SharpImage) {
  switch (mimeType) {
    case "image/jpeg":
      return { mimeType, image: image.jpeg({ quality: 90 }) };
    case "image/webp":
      return { mimeType, image: image.webp({ quality: 90 }) };
    default:
      return { mimeType: "image/png", image: image.png() };
  }
}

/**
 * Scale an image down to the largest size that Claude reads, so it loses no
 * detail that the model would see, and re-encode it when its data is too
 * large. Return the same image when it already fits, or when its size cannot
 * be read from its header.
 */
export async function fitModelImage(
  image: ImageContent,
): Promise<FittedModelImage> {
  const size = readImageDimensions(image);
  if (!size) return { image };
  const [width, height] = claudeMaxImageSize(size.width, size.height);
  const scale = width !== size.width || height !== size.height;
  if (!scale && image.data.length <= MAX_IMAGE_BASE64_CHARS) return { image };

  // sharp loads a native library, so load it only when an image must change.
  const { default: sharp } = await import("sharp");
  const source = Buffer.from(image.data, "base64");
  const { hasAlpha, orientation = 1 } = await sharp(source).metadata();
  // sharp drops metadata, so `rotate()` applies the EXIF orientation to the
  // pixels. Orientations 5 to 8 turn the image a quarter turn, so the upright
  // image has the header's width and height swapped.
  const turned = orientation >= 5;
  const from: [number, number] = turned
    ? [size.height, size.width]
    : [size.width, size.height];
  const to: [number, number] = turned ? [height, width] : [width, height];
  const resized = () =>
    sharp(source).rotate().resize({ width: to[0], height: to[1], fit: "fill" });
  const encoded = encodeLike(image.mimeType, resized());
  let mimeType = encoded.mimeType;
  let data = (await encoded.image.toBuffer()).toString("base64");
  if (data.length > MAX_IMAGE_BASE64_CHARS) {
    // JPEG is smallest for photos. WebP keeps transparency.
    mimeType = hasAlpha ? "image/webp" : "image/jpeg";
    data = (
      await (
        hasAlpha
          ? resized().webp({ quality: 85 })
          : resized().jpeg({ quality: 85 })
      ).toBuffer()
    ).toString("base64");
  }
  return {
    image: { type: "image", data, mimeType },
    ...(scale ? { scaled: { from, to } } : undefined),
  };
}

/**
 * Create a Pi `transformContext` that fits each image in the model request.
 * It heals history that already holds an image that the provider rejects.
 * Each image is fitted once for the life of the returned function. It never
 * throws: an image that cannot be fitted is sent unchanged.
 */
export function createContextImageFitter(): (
  messages: AgentMessage[],
) => Promise<AgentMessage[]> {
  const fitted = new WeakMap<ImageContent, ImageContent>();
  const fit = async (image: ImageContent): Promise<ImageContent> => {
    const known = fitted.get(image);
    if (known) return known;
    let result = image;
    try {
      result = (await fitModelImage(image)).image;
    } catch (error) {
      logWarn("image.model_fit.failed", {
        "app.file.mime_type": image.mimeType,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
    fitted.set(image, result);
    return result;
  };

  return async (messages) => {
    const output: AgentMessage[] = [];
    for (const message of messages) {
      if (
        (message.role !== "user" && message.role !== "toolResult") ||
        typeof message.content === "string" ||
        !message.content.some((part) => part.type === "image")
      ) {
        output.push(message);
        continue;
      }
      const content: typeof message.content = [];
      for (const part of message.content) {
        // One image at a time: a decoded image can use hundreds of MB.
        // oxlint-disable-next-line no-await-in-loop -- Bound decode memory to one image.
        content.push(part.type === "image" ? await fit(part) : part);
      }
      output.push(
        content.every((part, index) => part === message.content[index])
          ? message
          : { ...message, content },
      );
    }
    return output;
  };
}
