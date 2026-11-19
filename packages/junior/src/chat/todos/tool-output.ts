import * as z from "zod";
import { TODO_STATUSES, type Todo } from "@/chat/todos/types";

/** To-do shape in tool results. */
export const todoOutputSchema = z
  .object({
    id: z.number().int(),
    title: z.string(),
    notes: z.string().optional(),
    status: z.enum(TODO_STATUSES),
    assignee: z.string(),
  })
  .strict();

/** Render one To-do for a tool result, with assignee text for the reader. */
export function outputTodo(
  todo: Todo,
  assignee: string,
): z.output<typeof todoOutputSchema> {
  return {
    id: todo.id,
    title: todo.title,
    ...(todo.notes ? { notes: todo.notes } : undefined),
    status: todo.status,
    assignee,
  };
}
