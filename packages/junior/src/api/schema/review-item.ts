import { z } from "zod";
import { userInputRequestSchema } from "@/chat/tools/runtime/user-input-request";

const answerSchema = z
  .object({
    other: z.string().max(4000).optional(),
    requestId: z.string().min(1),
    values: z.record(z.string(), z.array(z.string().max(4000)).max(20)),
  })
  .strict();

const personSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    email: z.string().min(1),
    userId: z.string().min(1),
  })
  .strict();

/** One Review item as the viewer sees it. */
export const reviewItemSchema = z
  .object({
    addedByConversationId: z.string().min(1),
    answer: answerSchema.optional(),
    assignedToEveryone: z.boolean(),
    assignees: z.array(personSchema),
    automationId: z.string().min(1).optional(),
    body: z.string(),
    /** True when the viewer can take, submit, complete, or dismiss it. */
    canAct: z.boolean(),
    /** True when the viewer can act and is not already the only assignee. */
    canTake: z.boolean(),
    closeReason: z.string().min(1).optional(),
    closedAt: z.string().datetime().optional(),
    /** Unset for an open item, or when an agent closed it. */
    closedBy: personSchema.optional(),
    conversationIds: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    id: z.string().min(1),
    kind: z.enum(["notice", "action"]),
    request: userInputRequestSchema.optional(),
    status: z.enum(["open", "done", "dismissed"]),
    subject: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1).optional(),
        url: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    title: z.string().min(1),
    updatedAt: z.string().datetime(),
    visibility: z.enum(["public", "private"]),
  })
  .strict();

export type ReviewItemPayload = z.output<typeof reviewItemSchema>;

/** Review desk list filters. The list has every item the viewer can see. */
export const reviewItemListQuerySchema = z
  .object({
    /** `true` lists done and dismissed items instead of open ones. */
    archived: z.enum(["true", "false"]).optional(),
    conversationId: z.string().min(1).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict();

export const reviewItemListSchema = z
  .object({ items: z.array(reviewItemSchema) })
  .strict();

/** Open Review items that wait on the viewer. */
export const reviewItemCountSchema = z
  .object({
    /** Open items assigned to the viewer as a User. */
    mine: z.number().int().nonnegative(),
  })
  .strict();

/** Conversations with an open item assigned to the viewer or Everyone. */
export const reviewItemWaitingConversationsSchema = z
  .object({ conversationIds: z.array(z.string().min(1)) })
  .strict();

export const reviewItemParamsSchema = z
  .object({ id: z.string().min(1) })
  .strict();

/** One person action on a Review item. */
export const reviewItemActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("take") }).strict(),
  z.object({ action: z.literal("complete") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  z
    .object({
      action: z.literal("submit"),
      answer: answerSchema.omit({ requestId: true }),
    })
    .strict(),
]);

export type ReviewItemActionBody = z.output<typeof reviewItemActionSchema>;
