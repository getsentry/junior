import {
  defineJuniorPlugin,
  type PluginRegistration,
  type ToolRegistrationHookContext,
  withToolContext,
} from "@sentry/junior-plugin-api";
import { createMemoryAgent } from "./agent";
import { createMemoryApi } from "./api";
import { createMemoryCliCommand } from "./cli";
import {
  memoryArchiveTool,
  memoryRestoreTool,
  memoryCreateTool,
  memoryListTool,
  memorySearchTool,
  type MemoryCreateToolContext,
} from "./tools";
import { processMemorySession } from "./process-session";
import { reembedMemories } from "./reembed";
import { createMemoryPromptContributions } from "./recall";
import { buildMemoryOperationalReport } from "./operational-report";
import { extractionCostFlow, memoryCostsByDay } from "./model-cost";
import {
  memoriesCapturedEvent,
  memoriesCapturedEventV1,
  memoriesCapturedEventV2,
  memoriesRecalledEvent,
} from "./events";
import { archiveExpiredMemoriesInAllScopes, memoryDb } from "./store";
import { createMemoryUserPage } from "./user-pages";

const MEMORY_MODEL_ENV = "AI_MEMORY_MODEL";
const HEARTBEAT_REEMBED_BATCH_SIZE = 100;
// The host stops waiting for a plugin heartbeat after 25s. Leave time for the
// batch that is in progress when this budget ends.
const HEARTBEAT_REEMBED_BUDGET_MS = 15_000;
const HEARTBEAT_EXPIRED_ARCHIVE_LIMIT = 100;

/** App settings for Memory. */
export interface MemoryOptions {
  /** Disable automatic prompt recall while keeping explicit memory tools available. */
  disableRecall?: boolean;
  /** Disable passive memory extraction from completed sessions. */
  disableExtraction?: boolean;
  /** Model for extraction and supersession. Defaults to `AI_MEMORY_MODEL`, then the app structured model. */
  modelId?: string;
}

function memoryModelId(options: MemoryOptions): string | undefined {
  const explicitModelId = options.modelId?.trim();
  if (explicitModelId) {
    return explicitModelId;
  }
  const envModelId = process.env[MEMORY_MODEL_ENV]?.trim();
  return envModelId || undefined;
}

function memoryToolContext(
  ctx: ToolRegistrationHookContext,
): MemoryCreateToolContext {
  const agent = createMemoryAgent(ctx.model);
  return {
    agent,
    ...(ctx.conversationId
      ? { conversationId: ctx.conversationId }
      : undefined),
    ...(ctx.actor ? { actor: ctx.actor } : undefined),
    db: memoryDb(ctx.db),
    ...(ctx.embedder ? { embedder: ctx.embedder } : undefined),
    ...(ctx.locationId ? { locationId: ctx.locationId } : undefined),
    source: ctx.source,
    supersessionDecider: agent,
    users: ctx.users,
    ...(ctx.userText ? { userText: ctx.userText } : undefined),
  };
}

/** Build the Memory registration for these settings. */
export function createMemoryRegistration(
  options: MemoryOptions = {},
): PluginRegistration {
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
    conversationEvents: [
      memoriesCapturedEventV1,
      memoriesCapturedEventV2,
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
        const db = memoryDb(ctx.db);
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
        return await buildMemoryOperationalReport({
          db: memoryDb(ctx.db),
          extractionDays: memoryCostsByDay(
            ctx.eventStats,
            extractionCostFlow,
            90,
          ),
          nowMs: ctx.nowMs,
        });
      },
      apiRoutes(ctx) {
        return createMemoryApi({
          conversationEvents: ctx.conversationEvents,
          db: memoryDb(ctx.db),
          eventStats: ctx.eventStats,
          users: ctx.users,
        });
      },
      tools() {
        return withToolContext(
          {
            createMemory: memoryCreateTool,
            archiveMemory: memoryArchiveTool,
            restoreMemory: memoryRestoreTool,
            listMemories: memoryListTool,
            searchMemories: memorySearchTool,
          },
          memoryToolContext,
        );
      },
      disabledTools(ctx): Record<string, string> {
        // Only a person's message in a public Conversation may write memory.
        // Disable the write tools instead of omitting them, so the tool list
        // and the prompt cache stay the same in every Turn.
        if ("visibility" in ctx.source && ctx.source.visibility === "public") {
          return {};
        }
        const reason =
          "Only a person's message in a public Conversation can write memory.";
        return {
          createMemory: reason,
          archiveMemory: reason,
          restoreMemory: reason,
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
                db: memoryDb(ctx.db),
                embedder: ctx.embedder,
                events: ctx.events,
                ...(ctx.locationId
                  ? { locationId: ctx.locationId }
                  : undefined),
                loadHistory: ctx.loadHistory,
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

let configuredOptions: MemoryOptions = {};
let registration = createMemoryRegistration();

/** Replace the app's Memory settings and return the previous settings. */
export function setMemoryConfig(options: MemoryOptions = {}): MemoryOptions {
  const previous = configuredOptions;
  configuredOptions = { ...options };
  registration = createMemoryRegistration(configuredOptions);
  return previous;
}

/** Return the Memory registration for the current app settings. */
export function memoryRegistration(): PluginRegistration {
  return registration;
}
