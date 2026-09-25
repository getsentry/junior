import { INPUT_IMAGE_TYPES } from "./media";
import { z } from "zod";

/** Bound JSON image input below the hosting platform's request size limit. */
export const MAX_INPUT_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_INPUT_IMAGES = 3;

/** Image bytes accepted with a web message, never stored in its mailbox row. */
export const inputImageSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    contentType: z.enum(INPUT_IMAGE_TYPES),
    data: z
      .string()
      .min(4)
      .max((MAX_INPUT_IMAGE_BYTES * 4) / 3)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0),
  })
  .strict();

export type InputImage = z.output<typeof inputImageSchema>;

/** Safe attachment facts shared by mailbox input and transcript messages. */
export const messageAttachmentSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    contentType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export type MessageAttachment = z.output<typeof messageAttachmentSchema>;

/** Read attachment metadata without exposing object storage keys or bytes. */
export function readMessageAttachments(value: unknown): MessageAttachment[] {
  return messageAttachmentSchema.array().parse(value ?? []);
}
