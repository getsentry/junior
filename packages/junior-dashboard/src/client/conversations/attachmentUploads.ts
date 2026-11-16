import {
  acceptedConversationMessageSchema,
  attachmentUploadSchema,
} from "@sentry/junior/api/schema";
import { post } from "../http";

const CONTENT_TYPE = /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/;

/** The browser type from the file name, or plain bytes when it has none. */
function uploadContentType(file: File): string {
  const type = file.type.toLowerCase();
  return CONTENT_TYPE.test(type) ? type : "application/octet-stream";
}

/**
 * Write each file to attachment storage, then return the upload ids that the
 * send carries. Uploads are bound to the Message idempotency key, so a retry
 * with the same key can use new uploads.
 */
async function uploadMessageFiles(
  files: readonly File[] | undefined,
  message: { conversationId?: string | undefined; idempotencyKey: string },
): Promise<string[] | undefined> {
  if (!files?.length) return undefined;
  return await Promise.all(
    files.map(async (file) => {
      const { target, uploadId } = await post(
        attachmentUploadSchema,
        "/api/conversations/attachment-uploads",
        {
          ...message,
          bytes: file.size,
          contentType: uploadContentType(file),
          filename: file.name.trim().slice(0, 255) || "file",
        },
      );
      const response = await fetch(target.url, {
        body: file,
        headers: target.headers,
        method: target.method,
      });
      if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
      return uploadId;
    }),
  );
}

/**
 * Send a web Message. Its files go to attachment storage first, and the
 * Message carries only their upload ids.
 */
export async function postWebMessage<TBody extends { idempotencyKey: string }>(
  path: string,
  { files, ...body }: TBody & { files?: readonly File[] },
  conversationId?: string,
) {
  return await post(acceptedConversationMessageSchema, path, {
    ...body,
    uploadIds: await uploadMessageFiles(files, {
      conversationId,
      idempotencyKey: body.idempotencyKey,
    }),
  });
}
