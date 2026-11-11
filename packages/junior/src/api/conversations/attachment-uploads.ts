import type { User } from "@sentry/junior-plugin-api";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import {
  AttachmentUploadError,
  createAttachmentUpload,
  writeAttachmentUpload,
} from "@/chat/attachments/uploads";
import { getSqlExecutor } from "@/chat/db";
import { throwApiError } from "../http";
import type {
  AttachmentUpload,
  CreateAttachmentUploadBody,
} from "../schema/conversation-attachment-upload";
import { requireWebMessageConversation } from "./create";

/** API path that takes upload bytes when storage cannot sign browser writes. */
function apiUploadPath(uploadId: string): string {
  return `/api/conversations/attachment-uploads/${encodeURIComponent(uploadId)}`;
}

/**
 * Reserve one upload for a viewer's next web Message.
 *
 * The upload is bound to the viewer, the target Conversation, and the Message
 * idempotency key. The send checks all three.
 */
export async function createAttachmentUploadForViewer(
  viewer: User,
  body: CreateAttachmentUploadBody,
  storage: AttachmentStorage,
): Promise<AttachmentUpload> {
  const conversationId = await requireWebMessageConversation(
    viewer,
    body.conversationId,
    body.idempotencyKey,
  );
  const upload = await createAttachmentUpload({
    db: getSqlExecutor(),
    file: {
      bytes: body.bytes,
      contentType: body.contentType,
      filename: body.filename,
    },
    scope: {
      conversationId,
      idempotencyKey: body.idempotencyKey,
      userId: viewer.id,
    },
    storage,
  });
  return {
    uploadId: upload.id,
    target: upload.target ?? {
      headers: { "content-type": body.contentType },
      method: "PUT",
      url: apiUploadPath(upload.id),
    },
  };
}

/** Take upload bytes for storage that cannot sign browser writes. */
export async function writeAttachmentUploadForViewer(args: {
  body: Buffer;
  storage: AttachmentStorage;
  uploadId: string;
  viewer: User;
}): Promise<void> {
  if (args.storage.createUploadTarget) {
    // The browser writes to storage directly. Do not take bytes here.
    throwApiError(404, "Upload not found.");
  }
  try {
    await writeAttachmentUpload({
      body: args.body,
      db: getSqlExecutor(),
      storage: args.storage,
      uploadId: args.uploadId,
      userId: args.viewer.id,
    });
  } catch (error) {
    if (error instanceof AttachmentUploadError) {
      throwApiError(400, error.message);
    }
    throw error;
  }
}
