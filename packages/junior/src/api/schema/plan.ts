import * as z from "zod";
import { PLAN_ITEM_STATUSES } from "@/chat/plan/types";
import { conversationParamsSchema } from "./conversation";

const planItemAssigneeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      conversationId: z.string().min(1),
      name: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("user"),
      name: z.string().min(1).optional(),
    })
    .strict(),
]);

/**
 * One Plan item of a Conversation. Viewers who cannot see private content
 * get the status, assignee kind, and times, but not the title, notes, or
 * names.
 */
export const conversationPlanItemSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
    status: z.enum(PLAN_ITEM_STATUSES),
    assignee: planItemAssigneeSchema,
    /** Name of the person who made the latest change. */
    changedBy: z.string().min(1).optional(),
    redacted: z.literal(true).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.title === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "plan item title must be text or explicitly redacted",
      });
    }
  });

/** The open Plan items of one Conversation, then the latest closed ones. */
export const conversationPlanReportSchema = z
  .object({
    conversationId: z.string().min(1),
    items: z.array(conversationPlanItemSchema),
  })
  .strict();

/** Route parameters of one Plan item. */
export const planItemParamsSchema = conversationParamsSchema
  .extend({ itemId: z.coerce.number().int().positive() })
  .strict();

/** Status that a person can set on a Plan item. */
export const planItemStatusBodySchema = z
  .object({ status: z.enum(["pending", "done", "cancelled"]) })
  .strict();

export type ConversationPlanItem = z.infer<typeof conversationPlanItemSchema>;
export type ConversationPlanReport = z.infer<
  typeof conversationPlanReportSchema
>;
export type PlanItemStatusBody = z.infer<typeof planItemStatusBodySchema>;
