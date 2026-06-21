import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createMemoryAgent, type MemoryAgent } from "./agent";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryToolContext,
} from "./tools";
import { createMemoryPromptMessages } from "./recall";

function memoryToolContext(ctx: {
  agent: MemoryAgent;
  conversationId?: string;
  db: MemoryToolContext["db"];
  requester?: MemoryToolContext["requester"];
  source: MemoryToolContext["source"];
}): MemoryToolContext {
  return {
    agent: ctx.agent,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.requester ? { requester: ctx.requester } : {}),
    db: ctx.db,
    source: ctx.source,
  };
}

/** Create Junior's long-term memory plugin registration. */
export function createMemoryPlugin() {
  const agent = createMemoryAgent();

  return defineJuniorPlugin({
    database: {},
    manifest: {
      name: "memory",
      displayName: "Memory",
      description: "Long-term Junior memory storage and recall",
    },
    packageName: "@sentry/junior-memory",
    hooks: {
      tools(ctx) {
        const context = memoryToolContext({ ...ctx, agent });
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
          db: ctx.db,
          source: ctx.source,
          text: ctx.text,
        });
      },
    },
  });
}

export const memoryPlugin = createMemoryPlugin();
