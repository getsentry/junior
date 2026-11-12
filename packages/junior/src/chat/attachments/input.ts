import * as z from "zod";

/**
 * Largest file that a web Message can carry.
 *
 * `loadAttachment` reads the whole file into memory before it writes the file
 * to the sandbox, and the message request reads each upload once to check it.
 * Keep this well below function memory.
 */
export const MAX_INPUT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Most files on one web Message, as in one Slack message. */
export const MAX_INPUT_ATTACHMENTS = 10;

/** File facts that a browser declares before it uploads the bytes. */
export const inputFileSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    contentType: z
      .string()
      .trim()
      .toLowerCase()
      .max(127)
      .regex(/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/),
    bytes: z.number().int().min(1).max(MAX_INPUT_ATTACHMENT_BYTES),
  })
  .strict();

export type InputFile = z.output<typeof inputFileSchema>;

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
