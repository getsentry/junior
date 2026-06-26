import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createMemoryAgent, type MemoryAgent } from "./agent";
import { createMemoryCliCommand } from "./cli";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryToolContext,
} from "./tools";
import { createMemoryPromptMessages } from "./recall";
import type { MemoryDb } from "./store";

function memoryToolContext(ctx: {
  agent: MemoryAgent;
  conversationId?: string;
  db: MemoryToolContext["db"];
  embedder?: MemoryToolContext["embedder"];
  requester?: MemoryToolContext["requester"];
  source: MemoryToolContext["source"];
  userText?: string;
}): MemoryToolContext {
  return {
    agent: ctx.agent,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.requester ? { requester: ctx.requester } : {}),
    db: ctx.db,
    ...(ctx.embedder ? { embedder: ctx.embedder } : {}),
    source: ctx.source,
    ...(ctx.userText ? { userText: ctx.userText } : {}),
  };
}

/** Create Junior's long-term memory plugin registration. */
export function createMemoryPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "memory",
      displayName: "Memory",
      description: "Long-term Junior memory storage and recall",
    },
    packageName: "@sentry/junior-memory",
    cli: {
      commands: [createMemoryCliCommand()],
    },
    hooks: {
      tools(ctx) {
        const context = memoryToolContext({
          ...ctx,
          agent: createMemoryAgent(ctx.model),
          db: ctx.db as MemoryDb,
          embedder: ctx.embedder,
        });
        return {
          createMemory: createMemoryCreateTool(context),
          removeMemory: createMemoryRemoveTool(context),
          listMemories: createMemoryListTool(context),
          searchMemories: createMemorySearchTool(context),
        };
      },
      async userPrompt(ctx) {
        return await createMemoryPromptMessages({
          ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          ...(ctx.requester ? { requester: ctx.requester } : {}),
          db: ctx.db as MemoryDb,
          embedder: ctx.embedder,
          source: ctx.source,
          text: ctx.text,
        });
      },
    },
  });
}

export const memoryPlugin = createMemoryPlugin();
