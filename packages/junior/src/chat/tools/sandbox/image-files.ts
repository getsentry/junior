import {
  detectImageMediaType,
  type InputImageType,
} from "@/chat/attachments/media";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  normalizeSandboxPath,
  SandboxFileNotFoundError,
} from "@/chat/tools/sandbox/file-uploads";

/**
 * Read a sandbox image for a model request. The file signature, not the file
 * name, sets the MIME type.
 */
export async function readSandboxImage(
  path: string,
  readFile: (path: string) => Promise<Buffer | null | undefined>,
  maxBytes: number,
): Promise<{ data: Buffer; mimeType: InputImageType }> {
  const targetPath = normalizeSandboxPath(path);
  const data = await readFile(targetPath);
  if (!data) {
    throw new SandboxFileNotFoundError(targetPath);
  }
  if (data.byteLength === 0) {
    throw new ToolInputError(`image file is empty: ${targetPath}`);
  }
  if (data.byteLength > maxBytes) {
    throw new ToolInputError(
      `image exceeds ${maxBytes} bytes: ${targetPath} (${data.byteLength} bytes). Make the image smaller first.`,
    );
  }
  const mimeType = detectImageMediaType(data);
  if (!mimeType) {
    throw new ToolInputError(
      `not a readable image: ${targetPath} exists, but its content is not PNG, JPEG, GIF, or WebP data`,
    );
  }
  return { data, mimeType };
}

/**
 * Resize and re-encode an image until it fits in `maxBytes`. Try each longest
 * edge in order, largest first. Return undefined when no edge fits.
 */
export async function shrinkImage(
  data: Buffer,
  longestEdges: readonly number[],
  maxBytes: number,
): Promise<
  | {
      data: Buffer;
      mimeType: "image/jpeg" | "image/webp";
      width: number;
      height: number;
    }
  | undefined
> {
  // sharp loads a native library, so load it only when an image is too big.
  const { default: sharp } = await import("sharp");
  const { hasAlpha } = await sharp(data).metadata();
  // JPEG is smallest for photos. WebP keeps transparency.
  for (const edge of longestEdges) {
    const resized = sharp(data).rotate().resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    });
    const { data: encoded, info } = await (
      hasAlpha ? resized.webp({ quality: 90 }) : resized.jpeg({ quality: 90 })
    ).toBuffer({ resolveWithObject: true });
    if (encoded.byteLength <= maxBytes) {
      return {
        data: encoded,
        mimeType: hasAlpha ? "image/webp" : "image/jpeg",
        width: info.width,
        height: info.height,
      };
    }
  }
  return undefined;
}
