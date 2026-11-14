import * as z from "zod";

/**
 * Largest file that Junior stores from Slack or the web, or loads into the
 * sandbox.
 *
 * Every path streams the bytes, so this cap does not depend on function
 * memory. It bounds transfer time and sandbox disk use.
 */
export const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;
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
    bytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
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
    /**
     * True for a large Slack file that Junior never stores. Each read
     * downloads it from Slack, so it has no preview.
     */
    pending: z.literal(true).optional(),
  })
  .strict();

export type MessageAttachment = z.output<typeof messageAttachmentSchema>;

/** Read attachment metadata without exposing object storage keys or bytes. */
export function readMessageAttachments(value: unknown): MessageAttachment[] {
  return messageAttachmentSchema.array().parse(value ?? []);
}
