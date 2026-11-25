import * as z from "zod";
import { MAX_INPUT_ATTACHMENTS } from "@/chat/attachments/input";
import { conversationTitleSchema } from "./conversation-title";

/** Client key that makes a retried send the same Message. */
export const idempotencyKeySchema = z.string().trim().min(1).max(200);

export const createConversationMessageBodySchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    message: z.string().trim().max(32_000),
    /** Uploads from `POST /api/conversations/attachment-uploads`. */
    uploadIds: z
      .array(z.string().min(1).max(64))
      .max(MAX_INPUT_ATTACHMENTS)
      .optional(),
  })
  .strict()
  .refine(
    (body) => Boolean(body.message || body.uploadIds?.length),
    "Add a message or a file.",
  );

export const createConversationBodySchema =
  createConversationMessageBodySchema.safeExtend({
    /** Saved title. Title generation runs only when it is omitted. */
    title: conversationTitleSchema.optional(),
    /** New roots default public. Private roots stay participant-only. */
    visibility: z.enum(["private", "public"]).optional(),
    /**
     * Start the root in this Space. The viewer must be a member, and the
     * root must be public: every Space is public.
     */
    spaceId: z.string().uuid().optional(),
  });

export const acceptedConversationMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    status: z.enum(["accepted", "duplicate"]),
  })
  .strict();

export type CreateConversationBody = z.infer<
  typeof createConversationBodySchema
>;
export type CreateConversationMessageBody = z.infer<
  typeof createConversationMessageBodySchema
>;
export type AcceptedConversationMessage = z.infer<
  typeof acceptedConversationMessageSchema
>;
