import * as z from "zod";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { findChildAgentConversationId } from "@/chat/agent-invocations/bindings";
import { getDb, getSqlExecutor } from "@/chat/db";
import { renderTodoAssignee } from "@/chat/todos/prompt";
import {
  changeTodos,
  listTodos,
  type StoredTodoAssignee,
} from "@/chat/todos/store";
import {
  outputTodo,
  parseTodoRef,
  todoOutputSchema,
  todoRef,
  todoRefSchema,
} from "@/chat/todos/tool-output";
import {
  isOpenTodoStatus,
  TODO_STATUSES,
  SELF_TODO_ASSIGNEE,
  type Todo,
} from "@/chat/todos/types";
import {
  resolveAssignee,
  type FindMentionedUserId,
} from "@/chat/inbox-items/assignees";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";

const MAX_TODOS_PER_CALL = 50;

const statusSchema = z
  .enum(TODO_STATUSES)
  .describe(
    "in_progress marks work that has started. done and dropped close the To-do.",
  );

const assigneeSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .describe(
    "Who does the To-do: `self`, the name or conversation_id of a child agent, or a person's email or mention such as `<@U123>`. Null or omitted on a new To-do means `self`.",
  );

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Short outcome to reach.");

const notesSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe(
    "What you need to do the To-do later, such as the brief for a child agent.",
  );

const todoIdSchema = todoRefSchema.describe(
  "To-do id, such as `TODO-12`, from an earlier result or a To-do block.",
);

const changesSchema = <T extends z.ZodTypeAny>(entry: T) =>
  z.array(entry).min(1).max(MAX_TODOS_PER_CALL).nullable().optional();

const updateTodosInputSchema = z
  .object({
    add: changesSchema(
      z
        .object({
          title: titleSchema,
          notes: notesSchema.nullable().optional(),
          status: statusSchema
            .nullable()
            .optional()
            .describe("Null or omitted means open."),
          assignee: assigneeSchema.nullable().optional(),
        })
        .strict(),
    ).describe("New To-dos."),
    update: changesSchema(
      z
        .object({
          id: todoIdSchema,
          title: titleSchema.nullable().optional(),
          notes: notesSchema
            .nullable()
            .optional()
            .describe("New notes. Null clears them; omit to keep them."),
          status: statusSchema.nullable().optional(),
          assignee: assigneeSchema.nullable().optional(),
        })
        .strict(),
    ).describe("Changes to existing To-dos. Null or omitted fields stay."),
    remove: changesSchema(todoIdSchema).describe(
      "Ids of To-dos added by mistake. Close finished or dropped work with a status instead.",
    ),
  })
  .strict();

const updateTodosOutputSchema = juniorToolOutputSchema.extend({
  todos: z
    .array(todoOutputSchema)
    .describe(
      "To-dos that this call added or changed, or every open To-do when it changed none.",
    ),
  removed_ids: z.array(z.string()).optional(),
  replaced_person_changes: z
    .array(
      z
        .object({
          id: z.string(),
          status: z.enum(TODO_STATUSES),
          changed_by: z.string(),
        })
        .strict(),
    )
    .optional()
    .describe(
      "Statuses that a person set and this call replaced. Check that the person agrees, or set the status back.",
    ),
});

export const updateTodosToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Change your To-dos: the durable list of work that outlives this Turn, such as work queued for a later Turn, work for a child agent, or work for a person. They survive context compaction and sandbox resets. Do not add steps that you finish in this Turn. Give work for a child agent that child as assignee, with the brief in notes if you send it later. Returns the To-dos that changed, or every open To-do when the call changes nothing.",
  inputSchema: updateTodosInputSchema,
  outputSchema: updateTodosOutputSchema,
});

function outputTodoWithAssignee(todo: Todo) {
  return outputTodo(todo, renderTodoAssignee(todo.assignee));
}

/**
 * Resolve the assignee text of the model: the list's own agent, one of its
 * child agents, or a person. Only a child of this conversation can take a
 * To-do, as with `stopAgent`.
 */
async function resolveTodoAssignee(
  context: Pick<ToolRuntimeContext, "conversationId">,
  value: string,
  findMentionedUserId: FindMentionedUserId,
): Promise<StoredTodoAssignee> {
  const text = value.trim();
  if (
    text.toLowerCase() === SELF_TODO_ASSIGNEE ||
    text === context.conversationId
  ) {
    return { conversationId: context.conversationId };
  }
  const childConversationId = await findChildAgentConversationId({
    parentConversationId: context.conversationId,
    target: text,
  });
  if (childConversationId) return { conversationId: childConversationId };
  // An email or a mention. Its errors say how to fix a person who has no
  // Junior User.
  if (text.includes("@")) {
    const db = getDb();
    const tenant = (
      await readConversationAccessFromSql(db, [context.conversationId])
    ).get(context.conversationId)?.tenant;
    const person = await resolveAssignee(db, text, tenant, findMentionedUserId);
    if ("userId" in person) return { userId: person.userId };
  }
  throw new ToolInputError(
    `Unknown assignee ${JSON.stringify(text)}. Use ${SELF_TODO_ASSIGNEE}, the name or conversation_id of a child agent from listAgents, or the email or mention of one person.`,
  );
}

/** Create the tool that changes the durable To-dos of one conversation. */
export function createUpdateTodosTool(
  context: Pick<ToolRuntimeContext, "conversationId">,
  findMentionedUserId: FindMentionedUserId,
) {
  const assignee = (value: string) =>
    resolveTodoAssignee(context, value, findMentionedUserId);
  return zodTool({
    ...updateTodosToolDefinition,
    execute: async (input) => {
      const add = input.add ?? [];
      const update = input.update ?? [];
      const remove = (input.remove ?? []).map(parseTodoRef);
      const executor = getSqlExecutor();
      if (add.length + update.length + remove.length === 0) {
        const todos = await listTodos(executor, context.conversationId);
        return {
          todos: todos
            .filter((todo) => isOpenTodoStatus(todo.status))
            .map(outputTodoWithAssignee),
        };
      }
      const { todos, replacedPersonChanges } = await changeTodos(executor, {
        conversationId: context.conversationId,
        nowMs: Date.now(),
        change: {
          add: await Promise.all(
            // oxlint-disable-next-line junior/bounded-fan-out -- The tool schema allows at most 50 To-dos.
            add.map(async (todo) => ({
              title: todo.title,
              ...(todo.notes ? { notes: todo.notes } : undefined),
              status: todo.status ?? "open",
              assignee: await assignee(todo.assignee ?? SELF_TODO_ASSIGNEE),
            })),
          ),
          update: await Promise.all(
            // oxlint-disable-next-line junior/bounded-fan-out -- The tool schema allows at most 50 To-dos.
            update.map(async (todo) => ({
              id: parseTodoRef(todo.id),
              ...(todo.title ? { title: todo.title } : undefined),
              ...(todo.notes !== undefined ? { notes: todo.notes } : undefined),
              ...(todo.status ? { status: todo.status } : undefined),
              ...(todo.assignee
                ? { assignee: await assignee(todo.assignee) }
                : undefined),
            })),
          ),
          remove,
        },
      });
      return {
        todos: todos.map(outputTodoWithAssignee),
        ...(remove.length > 0
          ? { removed_ids: remove.map(todoRef) }
          : undefined),
        ...(replacedPersonChanges.length > 0
          ? {
              replaced_person_changes: replacedPersonChanges.map((todo) => ({
                id: todoRef(todo.id),
                status: todo.status,
                changed_by: todo.changedBy!.email,
              })),
            }
          : undefined),
      };
    },
  });
}
