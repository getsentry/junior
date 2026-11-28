import * as z from "zod";
import {
  inboxItemNoticeRequestSchema,
  inboxItemRequestSchema,
} from "@/chat/inbox-items/request";
import { actorIdentitySchema } from "./conversation";
import { inboxItemAnswerSchema, personSchema } from "./inbox-item";

/**
 * One question or notice that an agent gave a person in the Conversation,
 * with its answer and when it closed. Who it waits on is an Inbox fact, so
 * it is not here.
 */
export const conversationQuestionSchema = z
  .object({
    answer: inboxItemAnswerSchema.optional(),
    answeredAt: z.string().datetime().optional(),
    /** Who answered. Unset when no known person did. */
    answeredBy: personSchema
      .pick({ displayName: true, email: true, userId: true })
      .optional(),
    body: z.string(),
    /** When it was answered, done, or dismissed. Unset while it is open. */
    closedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    id: z.string().min(1),
    /** People that the title, body, and question mention. */
    mentions: z.array(actorIdentitySchema).optional(),
    /** The form and the related links. A notice has only the links. */
    request: z
      .union([inboxItemRequestSchema, inboxItemNoticeRequestSchema])
      .optional(),
    title: z.string(),
    /** The Turn that asked it, or last asked it again. */
    turnId: z.string().min(1).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** The questions of one Conversation, oldest first. */
export const conversationQuestionsReportSchema = z
  .object({
    conversationId: z.string().min(1),
    questions: z.array(conversationQuestionSchema),
  })
  .strict();

export type ConversationQuestion = z.infer<typeof conversationQuestionSchema>;
export type ConversationQuestionsReport = z.infer<
  typeof conversationQuestionsReportSchema
>;
