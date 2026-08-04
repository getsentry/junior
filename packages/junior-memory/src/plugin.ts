import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createMemoryAgent } from "./agent";
import { createMemoryApi } from "./api";
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
import { createMemoryPromptContributions } from "./recall";
import { buildMemoryOperationalReport } from "./operational-report";
import {
  memoriesCapturedEvent,
  memoriesCapturedEventV1,
  memoriesRecalledEvent,
} from "./events";
import type { MemoryDb } from "./store";
import { createMemoryUserPage } from "./user-pages";

const MEMORY_MODEL_ENV = "AI_MEMORY_MODEL";
const MEMORY_RECALL_MAX_VECTOR_DISTANCE_ENV =
  "MEMORY_RECALL_MAX_VECTOR_DISTANCE";
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
  actor?: MemoryToolContext["actor"];
  source: MemoryToolContext["source"];
  userText?: string;
}): MemoryToolContext {
  return {
    agent: ctx.agent,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.actor ? { actor: ctx.actor } : {}),
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
  actor?: MemoryCreateToolContext["actor"];
  source: MemoryCreateToolContext["source"];
  supersessionDecider: MemoryCreateToolContext["supersessionDecider"];
  userText?: string;
}): MemoryCreateToolContext {
  return {
    ...memoryToolContext(ctx),
    supersessionDecider: ctx.supersessionDecider,
  };
}

/** Register Junior's long-term memory plugin. */
export function memoryPlugin(options: MemoryPluginOptions = {}) {
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
    conversationEvents: [
      memoriesCapturedEventV1,
      memoriesCapturedEvent,
      memoriesRecalledEvent,
    ],
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
    userPages: [createMemoryUserPage()],
    hooks: {
      async operationalReport(ctx) {
        const extractionDays = await ctx.eventStats.costsByDay({
          days: 90,
          eventName: "memories_captured",
        });
        return await buildMemoryOperationalReport({
          db: ctx.db as MemoryDb,
          extractionDays,
          nowMs: ctx.nowMs,
        });
      },
      apiRoutes(ctx) {
        return createMemoryApi({
          db: ctx.db as MemoryDb,
          eventStats: ctx.eventStats,
          users: ctx.users,
        });
      },
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
        return await createMemoryPromptContributions({
          agent: createMemoryAgent(ctx.model),
          ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          ...(ctx.actor ? { actor: ctx.actor } : {}),
          db: ctx.db as MemoryDb,
          embedder: ctx.embedder,
          events: ctx.events,
          log: ctx.log,
          maxVectorDistance: recallMaxVectorDistance(options),
          source: ctx.source,
          text: ctx.text,
        });
      },
    },
  });
}
