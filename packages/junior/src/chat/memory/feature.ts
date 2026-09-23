import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { createMemoryAgent } from "./agent";
import { createMemoryCliCommand } from "./cli";
import {
  createMemoryArchiveTool,
  createMemoryCreateTool,
  createMemoryListTool,
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

/** Registration name for Memory. Plugins cannot claim it. */
export const MEMORY_FEATURE_NAME = "memory";

const memoryManifest = {
  name: MEMORY_FEATURE_NAME,
  displayName: "Memory",
  description: "Long-term Junior memory storage and recall",
};

export interface MemoryOptions {
  /**
   * Emergency switch. `false` removes memory tools, recall, extraction, views,
   * routes, and CLI commands while stored memory events keep rendering.
   */
  enabled?: boolean;
  /** Disable passive memory extraction from completed sessions. */
  disableExtraction?: boolean;
  /**
   * Structured review model. Defaults to `AI_MEMORY_MODEL`, then the app's
   * default model.
   */
  modelId?: string;
  /** Disable automatic prompt recall. The explicit memory tools stay available. */
  disableRecall?: boolean;
}

function memoryModelId(options: MemoryOptions): string | undefined {
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

/**
 * Register long-term Memory as a core feature.
 *
 * Memory uses the plugin registration contract so the host serves its tools,
 * recall, extraction task, events, user page, CLI, and operational report
 * through the shared runtime. Core mounts the REST routes in `api.ts`.
 */
export function createMemoryFeature(
  options: MemoryOptions = {},
): PluginRegistration {
  const conversationEvents = [
    memoriesCapturedEventV1,
    memoriesCapturedEvent,
    memoriesRecalledEvent,
  ];
  if (options.enabled === false) {
    return { manifest: memoryManifest, conversationEvents };
  }
  const modelId = memoryModelId(options);
  return {
    manifest: memoryManifest,
    model: modelId
      ? { structuredModelId: modelId }
      : { structuredModel: "default" },
    conversationEvents,
    cli: {
      commands: [createMemoryCliCommand()],
    },
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
  };
}
