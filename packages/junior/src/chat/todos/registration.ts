import type {
  PluginRegistration,
  PromptMessage,
} from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { findSlackMentionedUserId } from "@/chat/slack/inbox-item-tools";
import { parentTodosField } from "./parent-agent";
import {
  latestSeenTodosVersion,
  renderTodoDelta,
  renderTodosReview,
  renderTodosSnapshot,
} from "./prompt";
import { deleteTodos, listTodos, todosDb } from "./store";
import { TODOS_REGISTRATION_NAME } from "./types";
import { createUpdateTodosTool } from "./tools/update";

// The longest text of one prompt message. A long list of To-dos goes in
// several, split between To-dos.
const MAX_MESSAGE_CHARS = 8_000;

// The first entry is the version line, and each other entry is one To-do.
function todoEntries(text: string): string[] {
  return text.split(/\n(?=- TODO-)/);
}

function promptMessages(text: string | null): PromptMessage[] | undefined {
  if (!text) return undefined;
  const messages: PromptMessage[] = [];
  let current = "";
  for (const entry of todoEntries(text)) {
    if (current && current.length + entry.length + 1 > MAX_MESSAGE_CHARS) {
      messages.push({ text: current });
      current = entry;
    } else {
      current = current ? `${current}\n${entry}` : entry;
    }
  }
  messages.push({ text: current });
  return messages;
}

/**
 * Core registration of durable To-dos: work that outlives a Turn. It
 * reaches the agent only through plugin hooks: its tool, the To-do changes
 * in each Turn context, the snapshot in each compaction summary, the
 * parent's To-dos in a child's team listing, and purge.
 */
export const todosRegistration: PluginRegistration = {
  manifest: {
    name: TODOS_REGISTRATION_NAME,
    displayName: "To-dos",
    description: "Durable work that outlives a Turn",
  },
  hooks: {
    tools: () => ({
      updateTodos: createUpdateTodosTool(undefined, findSlackMentionedUserId),
    }),
    // The model's own changes are in its tool results. A Turn context shows
    // the changes that others made after the version that history shows,
    // else every open To-do when history has not shown them for a while.
    async userPrompt(ctx) {
      if (!ctx.conversationId || !ctx.historyMessages) return undefined;
      const todos = await listTodos(getSqlExecutor(), ctx.conversationId);
      const history = ctx.historyMessages();
      return promptMessages(
        renderTodoDelta(todos, latestSeenTodosVersion(history)) ??
          renderTodosReview(todos, history),
      );
    },
    async compactionContext(ctx) {
      return promptMessages(
        renderTodosSnapshot(
          await listTodos(getSqlExecutor(), ctx.conversationId),
        ),
      );
    },
    // Titles and notes come from the transcript, so they go with it.
    async purgeConversations(ctx) {
      await deleteTodos(todosDb(ctx.db), ctx.conversationIds);
    },
    parentAgentField: () => parentTodosField,
  },
};
