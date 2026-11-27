import * as z from "zod";
import { TODO_STATUSES } from "@/chat/todos/types";
import { conversationParamsSchema } from "./conversation";

const todoAssigneeSchema = z.discriminatedUnion("kind", [
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
      /** The To-do is assigned to the person who reads it. */
      viewer: z.literal(true).optional(),
    })
    .strict(),
]);

/**
 * One To-do of a Conversation. Viewers who cannot see private content
 * get the status, assignee kind, and times, but not the title, notes, or
 * names.
 */
export const conversationTodoSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
    status: z.enum(TODO_STATUSES),
    assignee: todoAssigneeSchema,
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
        message: "To-do title must be text or explicitly redacted",
      });
    }
  });

/** The open To-dos of one Conversation, then the latest closed ones. */
export const conversationTodosReportSchema = z
  .object({
    conversationId: z.string().min(1),
    todos: z.array(conversationTodoSchema),
  })
  .strict();

/** Route parameters of one To-do. */
export const todoParamsSchema = conversationParamsSchema
  .extend({ todoId: z.coerce.number().int().positive() })
  .strict();

/** Status that a person can set on a To-do. */
export const todoStatusBodySchema = z
  .object({ status: z.enum(TODO_STATUSES) })
  .strict();

export type ConversationTodo = z.infer<typeof conversationTodoSchema>;
export type ConversationTodosReport = z.infer<
  typeof conversationTodosReportSchema
>;
export type TodoStatusBody = z.infer<typeof todoStatusBodySchema>;
