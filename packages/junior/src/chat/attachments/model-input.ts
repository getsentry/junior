import type { AgentAttachment } from "@/chat/agent/types";
import { getSqlExecutor } from "@/chat/db";
import type { MessageAttachment } from "./input";
import { detectImageMediaType, isVisionImageMediaType } from "./media";
import { readLiveAttachment } from "./store";
import type { AttachmentStorage } from "./storage";

/**
 * Most current-message images that Slack and web send to the model in the
 * prompt. Other files, and images past the cap, get a `loadAttachment` note.
 */
export const MAX_MODEL_ATTACHMENTS = 3;
/** Largest file that Slack and web send to the model in the prompt. */
export const MAX_MODEL_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Tell the model how to read a stored file that the prompt does not carry. */
export function buildStoredAttachmentPromptText(args: {
  attachmentId: string;
  filename?: string;
  mediaType: string;
}): string {
  return [
    "<attachment>",
    `filename: ${args.filename ?? "unnamed"}`,
    `media_type: ${args.mediaType}`,
    `attachment_id: ${args.attachmentId}`,
    "Use loadAttachment with this id to access the original file.",
    "</attachment>",
  ].join("\n");
}

async function readStoredBytes(args: {
  attachment: MessageAttachment;
  conversationId: string;
  storage: AttachmentStorage;
}): Promise<Buffer> {
  const record = await readLiveAttachment({
    attachmentId: args.attachment.id,
    conversationId: args.conversationId,
    db: getSqlExecutor(),
  });
  if (!record || record.storageProvider !== args.storage.provider) {
    throw new Error("Input attachment is no longer available.");
  }
  const body = await args.storage.get(record.storageKey);
  if (!body) throw new Error("Input attachment contents are unavailable.");
  const data = Buffer.from(await new Response(body).arrayBuffer());
  if (data.byteLength !== record.bytes) {
    throw new Error("Input attachment size does not match stored metadata.");
  }
  return data;
}

/**
 * Build model input for the stored files of one web Message.
 *
 * Like Slack, the first images within the size limit go to the model as
 * images. Every other file gets a note that points to `loadAttachment`.
 */
export async function loadInputAttachments(args: {
  attachments: readonly MessageAttachment[];
  conversationId: string;
  storage: AttachmentStorage;
}): Promise<AgentAttachment[]> {
  let images = 0;
  return await Promise.all(
    args.attachments.map(async (attachment): Promise<AgentAttachment> => {
      const base = {
        attachmentId: attachment.id,
        filename: attachment.filename,
        mediaType: attachment.contentType,
      };
      const native =
        isVisionImageMediaType(attachment.contentType) &&
        attachment.bytes <= MAX_MODEL_ATTACHMENT_BYTES &&
        images < MAX_MODEL_ATTACHMENTS;
      if (!native) {
        return {
          ...base,
          promptText: buildStoredAttachmentPromptText({
            attachmentId: attachment.id,
            filename: attachment.filename,
            mediaType: attachment.contentType,
          }),
        };
      }
      images += 1;
      const data = await readStoredBytes({
        attachment,
        conversationId: args.conversationId,
        storage: args.storage,
      });
      // The bytes set the type, as on Slack. Bytes that are not an image
      // stay a stored file.
      const mediaType = detectImageMediaType(data);
      if (!mediaType) {
        return {
          ...base,
          promptText: buildStoredAttachmentPromptText({
            attachmentId: attachment.id,
            filename: attachment.filename,
            mediaType: attachment.contentType,
          }),
        };
      }
      return { ...base, data, mediaType };
    }),
  );
}
