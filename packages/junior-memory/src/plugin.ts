import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryToolContext,
} from "./memory-tools";
import type { MemoryAdjudicator } from "./adjudicator";

export interface MemoryPluginOptions {
  adjudicator?: MemoryAdjudicator;
}

function memoryToolContext(ctx: {
  adjudicator?: MemoryAdjudicator;
  conversationId?: string;
  db?: MemoryToolContext["db"];
  requester?: MemoryToolContext["requester"];
  source: MemoryToolContext["source"];
}): MemoryToolContext {
  if (!ctx.db) {
    throw new Error("Memory tools require plugin database access.");
  }
  return {
    ...(ctx.adjudicator ? { adjudicator: ctx.adjudicator } : {}),
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.requester ? { requester: ctx.requester } : {}),
    db: ctx.db,
    source: ctx.source,
  };
}

/** Create Junior's trusted long-term memory plugin registration. */
export function createMemoryPlugin(options: MemoryPluginOptions = {}) {
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
        const context = memoryToolContext({
          ...ctx,
          ...(options.adjudicator ? { adjudicator: options.adjudicator } : {}),
        });
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
