import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createMemoryAgent } from "./agent";
import { createMemoryApi } from "./api";
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
import { reembedMemories } from "./reembed";
import { createMemoryPromptContributions } from "./recall";
import { buildMemoryOperationalReport } from "./operational-report";
import { extractionCostFlow, memoryCostsByDay } from "./model-cost";
import {
  memoriesCapturedEvent,
  memoriesCapturedEventV1,
  memoriesRecalledEvent,
} from "./events";
import { archiveExpiredMemoriesInAllScopes, type MemoryDb } from "./store";
import { createMemoryUserPage } from "./user-pages";

const MEMORY_MODEL_ENV = "AI_MEMORY_MODEL";
const HEARTBEAT_REEMBED_BATCH_SIZE = 100;
// The host stops waiting for a plugin heartbeat after 25s. Leave time for the
// batch that is in progress when this budget ends.
const HEARTBEAT_REEMBED_BUDGET_MS = 15_000;
const HEARTBEAT_EXPIRED_ARCHIVE_LIMIT = 100;

export interface MemoryPluginOptions {
  /** Disable automatic prompt recall while keeping explicit memory tools available. */
  disableRecall?: boolean;
  /** Disable passive memory extraction from completed sessions. */
  disableExtraction?: boolean;
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

/** Register Junior's long-term memory plugin. */
export function memoryPlugin(options: MemoryPluginOptions = {}) {
  const modelId = memoryModelId(options);
  return defineJuniorPlugin({
    manifest: {
      name: "memory",
      displayName: "Memory",
      description: "Long-term memory storage and recall",
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
      async heartbeat(ctx) {
        const deadlineMs = Date.now() + HEARTBEAT_REEMBED_BUDGET_MS;
        const db = ctx.db as MemoryDb;
        // Archive before the re-embed. It is one bounded DB batch, so it
        // cannot starve the re-embed, and an embedder failure cannot stop it.
        // The re-embed deadline includes the time of this batch.
        await archiveExpiredMemoriesInAllScopes({
          db,
          limit: HEARTBEAT_EXPIRED_ARCHIVE_LIMIT,
          nowMs: ctx.nowMs,
        });
        // Embedding spans show progress. The host logs failures.
        await reembedMemories({
          batchSize: HEARTBEAT_REEMBED_BATCH_SIZE,
          db,
          deadlineMs,
          embedder: ctx.embedder,
        });
      },
      async operationalReport(ctx) {
        const extractionDays = await memoryCostsByDay(
          ctx.eventStats,
          extractionCostFlow,
          90,
        );
        return await buildMemoryOperationalReport({
          db: ctx.db as MemoryDb,
          extractionDays,
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
        // All memory is public, so only a person's message in a public
        // Conversation writes it. Child agents can suggest memories in their
        // result. Other Sources, such as automations, carry no visibility.
        // Disable the write tools instead of removing them, so the tool list
        // and the cached prompt stay the same in every Turn.
        const writeAccess =
          "visibility" in ctx.source && ctx.source.visibility === "public"
            ? {}
            : {
                disabledReason:
                  "Memory writes need a message from a person in a public Conversation.",
              };
        return {
          createMemory: {
            ...createMemoryCreateTool(
              memoryCreateToolContext({
                ...ctx,
                agent,
                db: ctx.db as MemoryDb,
                embedder: ctx.embedder,
                supersessionDecider: agent,
              }),
            ),
            ...writeAccess,
          },
          archiveMemory: {
            ...createMemoryArchiveTool(context),
            ...writeAccess,
          },
          listMemories: createMemoryListTool(context),
          searchMemories: createMemorySearchTool(context),
        };
      },
      ...(!options.disableRecall
        ? {
            async userPrompt(ctx) {
              return await createMemoryPromptContributions({
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
                reranker: ctx.reranker,
                setSpanAttributes: ctx.setSpanAttributes,
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
