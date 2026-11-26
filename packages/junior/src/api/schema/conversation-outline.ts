import * as z from "zod";
import { actorIdentitySchema } from "./conversation";

/**
 * Longest outline item text and reply. The outline previews each message,
 * so the server cuts the text and does not send whole messages.
 */
export const CONVERSATION_OUTLINE_TEXT_LENGTH = 200;

/**
 * The person messages of a whole Conversation, in seq order. The dashboard
 * outline uses it to show messages that the transcript did not load. It has
 * no items when the viewer cannot see the transcript.
 */
export const conversationOutlineSchema = z
  .object({
    items: z.array(
      z
        .object({
          seq: z.number().int().nonnegative(),
          createdAt: z.string().datetime(),
          /** Identity id of the author. Detail `authors` maps it to the person. */
          actorIdentityId: z.string().min(1).optional(),
          /** Set on input that a parent agent wrote, not a person. */
          fromParentAgent: z.literal(true).optional(),
          text: z.string().min(1),
          /** The last Junior text before the next item. */
          reply: z.string().min(1).optional(),
          /** People that the text or the reply mention. */
          mentions: z.array(actorIdentitySchema).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type ConversationOutline = z.infer<typeof conversationOutlineSchema>;
