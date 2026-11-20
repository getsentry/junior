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
