import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryToolContext,
} from "./memory-tools";

function memoryToolContext(ctx: {
  conversationId?: string;
  db?: MemoryToolContext["db"];
  requester?: MemoryToolContext["requester"];
  source: MemoryToolContext["source"];
}): MemoryToolContext {
  if (!ctx.db) {
    throw new Error("Memory tools require plugin database access.");
  }
  return {
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.requester ? { requester: ctx.requester } : {}),
    db: ctx.db,
    source: ctx.source,
  };
}

/** Create Junior's trusted long-term memory plugin registration. */
export function createMemoryPlugin() {
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
        const context = memoryToolContext(ctx);
        return {
          createMemory: createMemoryCreateTool(context),
          removeMemory: createMemoryRemoveTool(context),
          listMemories: createMemoryListTool(context),
          searchMemories: createMemorySearchTool(context),
        };
      },
    },
  });
}

export const memoryPlugin = createMemoryPlugin();
