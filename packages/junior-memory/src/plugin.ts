import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createMemoryAgent, type MemoryAgent } from "./agent";
import { createMemoryCliCommand } from "./cli";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryReviewer,
  type MemoryToolContext,
} from "./tools";
import { observeMemoryTurn } from "./observe";
import { createMemoryPromptMessages } from "./recall";
import type { MemoryDb } from "./store";

const MEMORY_MODEL_ENV = "AI_MEMORY_MODEL";

export interface MemoryPluginOptions {
  modelId?: string;
}

function memoryModelId(options: MemoryPluginOptions): string | undefined {
  const explicitModelId = options.modelId?.trim();
  if (explicitModelId) {
    return explicitModelId;
  }
  const envModelId = process.env[MEMORY_MODEL_ENV]?.trim();
  return envModelId || undefined;
}

function memoryToolContext(ctx: {
  agent: MemoryReviewer;
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
export function createMemoryPlugin(options: MemoryPluginOptions = {}) {
  const modelId = memoryModelId(options);
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
          agent: createMemoryAgent(ctx.model, {
            ...(modelId ? { modelId } : {}),
          }),
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
      async observeTurn(ctx) {
        await observeMemoryTurn(ctx, {
          ...(modelId ? { modelId } : {}),
        });
      },
    },
  });
}

export const memoryPlugin = createMemoryPlugin();
