import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createMemoryAgent } from "./agent";
import { createMemoryApi } from "./api";
import { createMemoryCliCommand } from "./cli";
import {
  memoriesCapturedEvent,
  memoriesCapturedEventV1,
  memoriesRecalledEvent,
} from "./events";
import { buildMemoryOperationalReport } from "./operational-report";
import { processMemorySession } from "./process-session";
import { createMemoryPromptContributions } from "./recall";
import type { MemoryDb } from "./store";
import {
  createMemoryArchiveTool,
  createMemoryCreateTool,
  createMemoryListTool,
  createMemorySearchTool,
  type MemoryCreateToolContext,
  type MemoryReviewer,
  type MemoryToolContext,
} from "./tools";
import { createMemoryUserPage } from "./user-pages";

const MEMORY_MODEL_ENV = "AI_MEMORY_MODEL";

export interface MemoryOptions {
  /** Disable automatic prompt recall while keeping explicit memory tools available. */
  disableRecall?: boolean;
  /** Disable passive memory extraction from completed sessions. */
  disableExtraction?: boolean;
  /** Structured model used by Memory. Defaults to AI_MEMORY_MODEL, then the default model. */
  modelId?: string;
}

function memoryModelId(options: MemoryOptions): string | undefined {
  return (
    options.modelId?.trim() ||
    process.env[MEMORY_MODEL_ENV]?.trim() ||
    undefined
  );
}

function memoryToolContext(ctx: {
  agent: MemoryReviewer;
  conversationId?: string;
  db: MemoryToolContext["db"];
  embedder?: MemoryToolContext["embedder"];
  locationId?: string;
  actor?: MemoryToolContext["actor"];
  source: MemoryToolContext["source"];
  users: MemoryToolContext["users"];
  userText?: string;
}): MemoryToolContext {
  return {
    agent: ctx.agent,
    ...(ctx.conversationId
      ? { conversationId: ctx.conversationId }
      : undefined),
    ...(ctx.actor ? { actor: ctx.actor } : undefined),
    db: ctx.db,
    ...(ctx.embedder ? { embedder: ctx.embedder } : undefined),
    ...(ctx.locationId ? { locationId: ctx.locationId } : undefined),
    source: ctx.source,
    users: ctx.users,
    ...(ctx.userText ? { userText: ctx.userText } : undefined),
  };
}

function memoryCreateToolContext(ctx: {
  agent: MemoryReviewer;
  conversationId?: string;
  db: MemoryCreateToolContext["db"];
  embedder?: MemoryCreateToolContext["embedder"];
  locationId?: string;
  actor?: MemoryCreateToolContext["actor"];
  source: MemoryCreateToolContext["source"];
  supersessionDecider: MemoryCreateToolContext["supersessionDecider"];
  users: MemoryCreateToolContext["users"];
  userText?: string;
}): MemoryCreateToolContext {
  return {
    ...memoryToolContext(ctx),
    supersessionDecider: ctx.supersessionDecider,
  };
}

/** Create the core Memory registration. */
export function createMemoryRegistration(options: MemoryOptions = {}) {
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
    conversationEvents: [
      memoriesCapturedEventV1,
      memoriesCapturedEvent,
      memoriesRecalledEvent,
    ],
    cli: { commands: [createMemoryCliCommand()] },
    tasks: options.disableExtraction
      ? {}
      : {
          processSession: {
            async run(ctx) {
              await processMemorySession(ctx);
            },
          },
        },
    userPages: [createMemoryUserPage()],
    hooks: {
      async operationalReport(ctx) {
        return await buildMemoryOperationalReport({
          db: ctx.db as MemoryDb,
          extractionDays: await ctx.eventStats.costsByDay({
            days: 90,
            eventName: "memories_captured",
          }),
          nowMs: ctx.nowMs,
        });
      },
      apiRoutes(ctx) {
        return createMemoryApi({
          conversationEvents: ctx.conversationEvents,
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
          archiveMemory: createMemoryArchiveTool(context),
          listMemories: createMemoryListTool(context),
          searchMemories: createMemorySearchTool(context),
        };
      },
      ...(!options.disableRecall
        ? {
            async userPrompt(ctx) {
              return await createMemoryPromptContributions({
                agent: createMemoryAgent(ctx.model),
                ...(ctx.conversationId
                  ? { conversationId: ctx.conversationId }
                  : undefined),
                ...(ctx.actor ? { actor: ctx.actor } : undefined),
                db: ctx.db as MemoryDb,
                embedder: ctx.embedder,
                events: ctx.events,
                ...(ctx.locationId
                  ? { locationId: ctx.locationId }
                  : undefined),
                log: ctx.log,
                source: ctx.source,
                text: ctx.text,
                users: ctx.users,
              });
            },
          }
        : undefined),
    },
  });
}
