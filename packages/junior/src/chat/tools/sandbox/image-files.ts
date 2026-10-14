import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  normalizeSandboxPath,
  SandboxFileNotFoundError,
} from "@/chat/tools/sandbox/file-uploads";

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

/**
 * Read a sandbox image for a model request. The file signature, not the file
 * name, sets the MIME type.
 */
export async function readSandboxImage(
  path: string,
  readFile: (path: string) => Promise<Buffer | null | undefined>,
  maxBytes: number,
): Promise<{ data: Buffer; mimeType: string }> {
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
  const mimeType = detectImageMimeType(data);
  if (!mimeType) {
    throw new ToolInputError(
      `unsupported image format: ${targetPath}; use PNG, JPEG, GIF, or WebP`,
    );
  }
  return { data, mimeType };
}
