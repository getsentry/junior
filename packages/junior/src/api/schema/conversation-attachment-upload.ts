import * as z from "zod";
import { inputFileSchema } from "@/chat/attachments/input";
import { idempotencyKeySchema } from "./conversation";

/**
 * Ask to upload one file for a Message. `conversationId` names an existing
 * Conversation; without it, the file is for the Conversation that the first
 * Message with this idempotency key creates.
 */
export const createAttachmentUploadBodySchema = inputFileSchema
  .safeExtend({
    conversationId: z.string().min(1).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

/** Upload id and the request that writes the file bytes. */
export const attachmentUploadSchema = z
  .object({
    uploadId: z.string().min(1),
    target: z
      .object({
        headers: z.record(z.string(), z.string()),
        method: z.literal("PUT"),
        url: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const attachmentUploadParamsSchema = z
  .object({ uploadId: z.string().uuid() })
  .strict();

export type CreateAttachmentUploadBody = z.infer<
  typeof createAttachmentUploadBodySchema
>;
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;
