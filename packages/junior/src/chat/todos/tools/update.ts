import {
  definePluginTool,
  PluginToolInputError,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { findChildAgentConversationId } from "@/chat/child-agents/bindings";
import { getDb, getSqlExecutor } from "@/chat/db";
import { renderTodoAssignee } from "@/chat/todos/prompt";
import {
  changeTodos,
  closeTodosForChild,
  listParentTodoIds,
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
  type ClosedTodoStatus,
  type Todo,
} from "@/chat/todos/types";
import {
  resolveAssignee,
  type FindMentionedUserId,
} from "@/chat/questions/assignees";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";

const MAX_TODOS_PER_CALL = 50;

const statusSchema = z
  .enum(TODO_STATUSES)
  .describe(
    "in_progress marks work that has started. Set done or dropped in the Turn that the work ends, such as when its pull request merges, or when a child agent's result says the work is finished, not only that its Turn ended.",
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
    ).describe(
      "Changes to existing To-dos. Null or omitted fields stay. A child agent can also set its parent's To-dos with assignee self in listAgents to done or dropped, and change nothing else on them.",
    ),
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

type TodoUpdateInput = NonNullable<
  z.output<typeof updateTodosInputSchema>["update"]
>[number];

function closedStatus(update: TodoUpdateInput): ClosedTodoStatus {
  const { assignee, id, notes, status, title } = update;
  if (
    (status !== "done" && status !== "dropped") ||
    title ||
    notes !== undefined ||
    assignee
  ) {
    throw new ToolInputError(
      `${id} is a To-do of your parent. Set only its status, to done or dropped.`,
    );
  }
  return status;
}

/**
 * Split updates into the parent's To-dos assigned to this child agent and
 * the conversation's own. The parent's go to `closeTodosForChild`, which
 * checks the assignee again under the parent's lock.
 */
async function splitParentUpdates(
  conversationId: string,
  update: TodoUpdateInput[],
) {
  const parent = new Map<number, ClosedTodoStatus>();
  if (update.length === 0) return { own: update, parent };
  const parentIds = await listParentTodoIds(getSqlExecutor(), conversationId);
  const own: TodoUpdateInput[] = [];
  for (const entry of update) {
    const id = parseTodoRef(entry.id);
    if (parentIds.has(id)) parent.set(id, closedStatus(entry));
    else own.push(entry);
  }
  return { own, parent };
}

// Change the To-dos of one conversation and return the changed ones.
async function updateTodos(
  context: Pick<ToolRuntimeContext, "conversationId">,
  findMentionedUserId: FindMentionedUserId,
  input: z.output<typeof updateTodosInputSchema>,
): Promise<z.input<typeof updateTodosOutputSchema>> {
  const assignee = (value: string) =>
    resolveTodoAssignee(context, value, findMentionedUserId);
  const add = input.add ?? [];
  const remove = (input.remove ?? []).map(parseTodoRef);
  const executor = getSqlExecutor();
  // Split before any write, so a bad change to a parent's To-do fails
  // the whole call.
  const split = await splitParentUpdates(
    context.conversationId,
    input.update ?? [],
  );
  const update = split.own;
  if (add.length + update.length + remove.length + split.parent.size === 0) {
    const todos = await listTodos(executor, context.conversationId);
    return {
      todos: todos
        .filter((todo) => isOpenTodoStatus(todo.status))
        .map(outputTodoWithAssignee),
    };
  }
  const own =
    add.length + update.length + remove.length > 0
      ? await changeTodos(executor, {
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
                ...(todo.notes !== undefined
                  ? { notes: todo.notes }
                  : undefined),
                ...(todo.status ? { status: todo.status } : undefined),
                ...(todo.assignee
                  ? { assignee: await assignee(todo.assignee) }
                  : undefined),
              })),
            ),
            remove,
          },
        })
      : { todos: [], replacedPersonChanges: [] };
  const closedForParent =
    split.parent.size > 0
      ? await closeTodosForChild(executor, {
          childConversationId: context.conversationId,
          nowMs: Date.now(),
          statuses: split.parent,
        })
      : [];
  return {
    todos: [
      ...own.todos.map(outputTodoWithAssignee),
      // The parent assigned these to this child, so they show assignee self.
      ...closedForParent.map((todo) => outputTodo(todo, SELF_TODO_ASSIGNEE)),
    ],
    ...(remove.length > 0 ? { removed_ids: remove.map(todoRef) } : undefined),
    ...(own.replacedPersonChanges.length > 0
      ? {
          replaced_person_changes: own.replacedPersonChanges.map((todo) => ({
            id: todoRef(todo.id),
            status: todo.status,
            changed_by: todo.changedBy!.email,
          })),
        }
      : undefined),
  };
}

/**
 * Create the tool that changes the durable To-dos of one conversation: the
 * Turn's conversation, or `context` when it is not undefined. A Slack
 * mention names a person through `findMentionedUserId`.
 */
export function createUpdateTodosTool(
  context: Pick<ToolRuntimeContext, "conversationId"> | undefined,
  findMentionedUserId: FindMentionedUserId,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Change your To-dos: the durable list of work that outlives this Turn, such as work queued for a later Turn, work for a child agent, or work for a person. They survive compaction and sandbox resets, so keep no backlog in a file. Do not add steps that you finish in this Turn, repeat To-dos in chat, or write their ids to people. Give work for a child agent that child as assignee, with the brief in notes if you send it later. Returns the To-dos that changed, or every open To-do when the call changes nothing.",
    exposure: "direct",
    inputSchema: updateTodosInputSchema,
    outputSchema: updateTodosOutputSchema,
    // A caller that binds `context` passes no Turn context.
    execute: async (
      input,
      _options,
      ctx: ToolRegistrationHookContext | void,
    ) => {
      const conversationId = context?.conversationId ?? ctx?.conversationId;
      if (!conversationId) {
        throw new PluginToolInputError(
          "This Turn has no conversation, so it has no To-dos.",
        );
      }
      return await updateTodos({ conversationId }, findMentionedUserId, input);
    },
  });
}
