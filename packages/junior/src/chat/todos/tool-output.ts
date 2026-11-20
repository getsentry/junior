import * as z from "zod";
import { TODO_STATUSES, type Todo } from "@/chat/todos/types";

// The model sees `TODO-12`, not `12` or `#12`: a bare `#12` in a reply reads
// as a GitHub pull request or issue.
const TODO_REF_PREFIX = "TODO-";

/** Render the model-facing reference of a To-do id. */
export function todoRef(id: number): string {
  return `${TODO_REF_PREFIX}${id}`;
}

/** To-do reference that the model passes back to a tool, such as `TODO-12`. */
export const todoRefSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^${TODO_REF_PREFIX}[1-9]\\d*$`),
    `Use a To-do reference such as ${TODO_REF_PREFIX}12.`,
  );

/** Read the To-do id from a reference that `todoRefSchema` accepted. */
export function parseTodoRef(ref: string): number {
  return Number(ref.trim().slice(TODO_REF_PREFIX.length));
}

/** To-do shape in tool results. */
export const todoOutputSchema = z
  .object({
    id: z.string(),
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
    id: todoRef(todo.id),
    title: todo.title,
    ...(todo.notes ? { notes: todo.notes } : undefined),
    status: todo.status,
    assignee,
  };
}
