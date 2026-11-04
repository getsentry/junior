import { z } from "zod";

export const forkConversationBodySchema = z
  .object({
    /** Assistant reply that ends the copied history. */
    messageId: z.string().min(1).max(500),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const forkConversationResponseSchema = z
  .object({ conversationId: z.string() })
  .strict();

/** Longest text of one Quick question message. */
const MAX_QUICK_QUESTION_TEXT_CHARS = 20_000;
/** Longest selection. The dashboard clips longer selections to this. */
const MAX_QUICK_QUESTION_QUOTE_CHARS = 4_000;

export const quickQuestionBodySchema = z
  .object({
    /** Assistant reply that ends the history the model reads. */
    messageId: z.string().min(1).max(500),
    /** Text the person selected in that reply. */
    quote: z.string().trim().min(1).max(MAX_QUICK_QUESTION_QUOTE_CHARS),
    /**
     * The whole thread so far: questions and answers in order, ending with
     * the new question. Nothing saves the thread, so the browser sends it.
     */
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().trim().min(1).max(MAX_QUICK_QUESTION_TEXT_CHARS),
          })
          .strict(),
      )
      .min(1)
      .max(21)
      .refine(
        (messages) =>
          messages.length % 2 === 1 &&
          messages.every(
            (message, index) =>
              message.role === (index % 2 === 0 ? "user" : "assistant"),
          ),
        "Messages must alternate, start and end with a question.",
      ),
  })
  .strict();

export const quickQuestionResponseSchema = z
  .object({ text: z.string().min(1) })
  .strict();

export type ForkConversationBody = z.infer<typeof forkConversationBodySchema>;
export type QuickQuestionBody = z.infer<typeof quickQuestionBodySchema>;
