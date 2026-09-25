import type { AgentAttachment } from "@/chat/agent/types";
import { getSqlExecutor } from "@/chat/db";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import {
  type InputImage,
  type MessageAttachment,
  MAX_INPUT_IMAGE_BYTES,
} from "./input";
import { readLiveAttachment, storeAttachment } from "./store";
import type { AttachmentStorage } from "./storage";

/** Check declared image types against file signatures before storing uploads. */
export function decodeInputImages(
  images: readonly InputImage[],
): SandboxFileUpload[] {
  const files = images.map((image) => {
    const data = Buffer.from(image.data, "base64");
    const matches =
      image.contentType === "image/png"
        ? data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.contentType === "image/jpeg"
          ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
          : image.contentType === "image/gif"
            ? ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))
            : data.toString("ascii", 0, 4) === "RIFF" &&
              data.toString("ascii", 8, 12) === "WEBP";
    if (!matches || data.toString("base64") !== image.data) {
      throw new Error("Use PNG, JPEG, GIF, or WebP image files.");
    }
    return {
      data,
      bytes: data.byteLength,
      filename: image.filename,
      mimeType: image.contentType,
      path: image.filename,
    };
  });
  if (
    files.reduce((sum, file) => sum + file.bytes, 0) > MAX_INPUT_IMAGE_BYTES
  ) {
    throw new Error("Images must total 3 MB or less.");
  }
  return files;
}

/** Store image bytes before accepting a message into the mailbox. */
export async function storeInputImages(args: {
  conversationId: string;
  files: readonly SandboxFileUpload[];
  storage: AttachmentStorage;
}): Promise<MessageAttachment[]> {
  return await Promise.all(
    args.files.map(async (file) => {
      const stored = await storeAttachment({
        conversationId: args.conversationId,
        db: getSqlExecutor(),
        file,
        storage: args.storage,
      });
      return {
        id: stored.id,
        filename: file.filename,
        contentType: file.mimeType,
        bytes: file.bytes,
      };
    }),
  );
}

/** Load stored images for model input. */
export async function loadInputImages(args: {
  attachments: readonly MessageAttachment[];
  conversationId: string;
  storage: AttachmentStorage;
}): Promise<AgentAttachment[]> {
  return await Promise.all(
    args.attachments.map(async (ref) => {
      const attachment = await readLiveAttachment({
        attachmentId: ref.id,
        conversationId: args.conversationId,
        db: getSqlExecutor(),
      });
      if (!attachment || attachment.storageProvider !== args.storage.provider) {
        throw new Error("Input image is no longer available.");
      }
      const body = await args.storage.get(attachment.storageKey);
      if (!body) throw new Error("Input image contents are unavailable.");
      const data = Buffer.from(await new Response(body).arrayBuffer());
      if (data.byteLength !== attachment.bytes) {
        throw new Error("Input image size does not match stored metadata.");
      }
      return {
        attachmentId: ref.id,
        filename: attachment.filename,
        mediaType: attachment.contentType,
        data,
      };
    }),
  );
}
