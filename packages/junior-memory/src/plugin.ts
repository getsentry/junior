import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createMemoryAgent } from "./agent";
import { createMemoryCliCommand } from "./cli";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryCreateToolContext,
  type MemoryReviewer,
  type MemoryToolContext,
} from "./tools";
import { processMemorySession } from "./process-session";
import { createMemoryPromptMessages } from "./recall";
import type { MemoryDb } from "./store";

const MEMORY_MODEL_ENV = "AI_MEMORY_MODEL";
const MEMORY_RECALL_MAX_VECTOR_DISTANCE_ENV = "MEMORY_RECALL_MAX_VECTOR_DISTANCE";
const DEFAULT_RECALL_MAX_VECTOR_DISTANCE = 0.45;

export interface MemoryPluginOptions {
  modelId?: string;
  /** Maximum cosine distance for vector recall candidates. Defaults to MEMORY_RECALL_MAX_VECTOR_DISTANCE env or 0.45. */
  recallMaxVectorDistance?: number;
}

function memoryModelId(options: MemoryPluginOptions): string | undefined {
  const explicitModelId = options.modelId?.trim();
  if (explicitModelId) {
    return explicitModelId;
  }
  const envModelId = process.env[MEMORY_MODEL_ENV]?.trim();
  return envModelId || undefined;
}

function recallMaxVectorDistance(options: MemoryPluginOptions): number {
  if (options.recallMaxVectorDistance !== undefined) {
    return options.recallMaxVectorDistance;
  }
  const raw = process.env[MEMORY_RECALL_MAX_VECTOR_DISTANCE_ENV]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, 1);
    }
  }
  return DEFAULT_RECALL_MAX_VECTOR_DISTANCE;
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

function memoryCreateToolContext(ctx: {
  agent: MemoryReviewer;
  conversationId?: string;
  db: MemoryCreateToolContext["db"];
  embedder?: MemoryCreateToolContext["embedder"];
  requester?: MemoryCreateToolContext["requester"];
  source: MemoryCreateToolContext["source"];
  supersessionDecider: MemoryCreateToolContext["supersessionDecider"];
  userText?: string;
}): MemoryCreateToolContext {
  return {
    ...memoryToolContext(ctx),
    supersessionDecider: ctx.supersessionDecider,
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
    model: modelId
      ? { structuredModelId: modelId }
      : { structuredModel: "default" },
    packageName: "@sentry/junior-memory",
    cli: {
      commands: [createMemoryCliCommand()],
    },
    tasks: {
      processSession: {
        async run(ctx) {
          await processMemorySession(ctx);
        },
      },
    },
    hooks: {
      tools(ctx) {
        const agent = createMemoryAgent(ctx.model);
        const context = memoryToolContext({
          ...ctx,
          agent,
          db: ctx.db as MemoryDb,
          embedder: ctx.embedder,
        });
        return {
          createMemory: createMemoryCreateTool(
            memoryCreateToolContext({
              ...ctx,
              agent,
              db: ctx.db as MemoryDb,
              embedder: ctx.embedder,
              supersessionDecider: agent,
            }),
          ),
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
          maxVectorDistance: recallMaxVectorDistance(options),
          source: ctx.source,
          text: ctx.text,
        });
      },
    },
  });
}

export const memoryPlugin = createMemoryPlugin();
