import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  pgliteBtreeGinExtension,
  pgliteVectorExtension,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import {
  createWebSource,
  createLocalSource,
  createSlackSource,
  pluginApiRouteRequestContextSchema,
  PluginToolInputError,
  type PluginConversationEventValue,
  type PluginLogger,
  type PluginModel,
  type PluginRunTranscriptEntry,
  type PluginState,
  type PluginTaskContext,
  type Actor,
} from "@sentry/junior-plugin-api";
import { Command, CommanderError } from "commander";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as memorySqlSchema from "../src/db/schema";
import {
  createMemoryApi,
  memoryApiSchema,
  memoryDashboardResponseSchema,
  memoryListResponseSchema,
} from "../src/api";
import { createMemoryAgent, type CreateMemoryRequest } from "../src/agent";
import { createMemoryCliCommand } from "../src/cli";
import { memoryPlugin } from "../src/plugin";
import { processMemorySession } from "../src/process-session";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryReviewer,
} from "../src/tools";
import { createViewerMemories } from "../src/viewer";
import { createMemoryStore, type MemoryDb } from "../src/store";
import type {
  MemorySupersessionDecider,
  MemorySupersessionInput,
} from "../src/store";
const TEST_NOW_MS = Date.parse("2026-06-19T12:00:00.000Z");
const TEST_EMBEDDING_DIMENSIONS = 1536;
const __dirname = dirname(fileURLToPath(import.meta.url));

type MemoryFixture = LocalPgliteFixture<MemoryDb>;

const noopLogger: PluginLogger = {
  error() {},
  info() {},
  warn() {},
};

const memoryState: PluginState = {
  async delete() {},
  async get() {
    return undefined;
  },
  async set() {},
  async setIfNotExists() {
    return true;
  },
  async withLock(_key, _ttlMs, callback) {
    return await callback();
  },
};

function createMemoryState(): PluginState {
  const values = new Map<string, unknown>();
  return {
    async delete(key) {
      values.delete(key);
    },
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async setIfNotExists(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async withLock(_key, _ttlMs, callback) {
      return await callback();
    },
  };
}

const defaultEmbedding = unitEmbedding(0);

function memoryDb(fixture: MemoryFixture): MemoryDb {
  return fixture.db();
}

async function runMemoryCli(fixture: MemoryFixture, argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const definition = createMemoryCliCommand();
  let exitCode = 0;
  const io = {
    stderr: {
      write(text: string) {
        stderr.push(text);
      },
    },
    stdout: {
      write(text: string) {
        stdout.push(text);
      },
    },
    writeError: (text: string) => stderr.push(text),
    writeOutput: (text: string) => stdout.push(text),
  };
  const command = new Command(definition.name)
    .description(definition.summary)
    .exitOverride()
    .showHelpAfterError()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
      outputError: (text, write) => {
        write(text);
      },
    });
  definition.configure(command, {
    action(handler) {
      return async (...args) => {
        const result = await handler(
          {
            command: {
              name: definition.name,
              summary: definition.summary,
            },
            db: memoryDb(fixture),
            io,
            log: noopLogger,
            plugin: { name: "memory" },
          },
          ...args,
        );
        exitCode = result ?? 0;
      };
    },
  });

  try {
    await command.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      exitCode = error.exitCode;
    } else {
      throw error;
    }
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

async function createMemoryFixture(): Promise<MemoryFixture> {
  const fixture = await createLocalPgliteFixture<MemoryDb>(memorySqlSchema, {
    extensions: {
      btree_gin: pgliteBtreeGinExtension,
      vector: pgliteVectorExtension,
    },
  });
  const migrationsDir = resolve(__dirname, "../migrations");
  const migrations = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrations) {
    const migration = await readFile(resolve(migrationsDir, migrationFile), {
      encoding: "utf8",
    });
    await fixture.execute(migration);
  }
  return fixture;
}

async function installViewerCoreTables(fixture: MemoryFixture): Promise<void> {
  await fixture.execute(`
CREATE TABLE junior_destinations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_tenant_id TEXT NOT NULL,
  provider_destination_id TEXT NOT NULL
);
CREATE TABLE junior_conversations (
  conversation_id TEXT PRIMARY KEY,
  root_conversation_id TEXT,
  destination_id TEXT
);
CREATE TABLE junior_conversation_participants (
  user_id TEXT NOT NULL,
  root_conversation_id TEXT NOT NULL
)
`);
}

function unitEmbedding(index: number): number[] {
  const embedding = Array.from({ length: TEST_EMBEDDING_DIMENSIONS }, () => 0);
  embedding[index] = 1;
  return embedding;
}

function cosineEmbedding(cosine: number): number[] {
  const embedding = Array.from({ length: TEST_EMBEDDING_DIMENSIONS }, () => 0);
  embedding[0] = cosine;
  embedding[1] = Math.sqrt(1 - cosine * cosine);
  return embedding;
}

function createTestEmbedder(
  vectors: Record<string, number[]> = {},
  overrides: {
    costUsd?: number;
    dimensions?: number;
    model?: string;
    provider?: string;
  } = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    async embedTexts(input: { texts: string[] }) {
      calls.push(input.texts);
      return {
        ...(overrides.costUsd !== undefined
          ? { costUsd: overrides.costUsd }
          : undefined),
        dimensions: overrides.dimensions ?? TEST_EMBEDDING_DIMENSIONS,
        model: overrides.model ?? "test-embedding-model",
        provider: overrides.provider ?? "test-embedding-provider",
        vectors: input.texts.map((text) => vectors[text] ?? defaultEmbedding),
      };
    },
  };
}

function recallModel(
  select: (candidates: string[]) => string[],
  costUsd?: number,
): PluginModel {
  return {
    async completeObject(input) {
      const encoded =
        /<candidate-memories>\n(.+)\n<\/candidate-memories>/s.exec(
          input.prompt,
        )?.[1];
      const candidates = JSON.parse(
        (encoded ?? "[]")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      ) as Array<{
        content: string;
        id: string;
      }>;
      return {
        ...(costUsd !== undefined ? { costUsd } : undefined),
        object: {
          relevantIds: select(candidates.map(({ content }) => content)).map(
            (content) =>
              candidates.find((candidate) => candidate.content === content)!.id,
          ),
        },
      };
    },
  };
}

const selectAllRecallModel = recallModel((candidates) => candidates);

function extractionModel(
  memories: Array<{
    content: string;
    expiresAtMs?: number | null;
    kind: "preference" | "procedure" | "knowledge";
    evidenceMessageIndices?: number[];
  }>,
  costUsd?: number,
) {
  const calls: Parameters<PluginModel["completeObject"]>[0][] = [];
  const model: PluginModel = {
    async completeObject(input) {
      calls.push(input);
      const toResponseMemory = (memory: (typeof memories)[number]) => ({
        canonicalFact: memory.content,
        expiresAtMs: memory.expiresAtMs ?? null,
        kind: memory.kind,
        evidenceMessageIndices: memory.evidenceMessageIndices ?? [0],
      });
      return {
        ...(costUsd !== undefined ? { costUsd } : undefined),
        object: {
          memories: memories.map(toResponseMemory),
        },
      };
    },
  };
  return { calls, model };
}

const localInstructionActor: Actor = {
  platform: "local",
  userId: "local-user",
};

/** A run-actor instruction transcript message. */
function instructionMessage(
  text: string,
  actor: Actor = localInstructionActor,
): PluginRunTranscriptEntry {
  return {
    type: "message",
    role: "user",
    text,
    provenance: { authority: "instruction", actor },
    isRunActor: true,
  };
}

/** An attributed public participant instruction that is not run authority. */
function nonRunActorInstructionMessage(
  text: string,
  actor: Actor,
): PluginRunTranscriptEntry {
  return {
    type: "message",
    role: "user",
    text,
    provenance: { authority: "instruction", actor },
    isRunActor: false,
  };
}

/** A non-run-actor ambient context transcript message. */
function contextMessage(text: string, actor?: Actor): PluginRunTranscriptEntry {
  return {
    type: "message",
    role: "user",
    text,
    provenance: { authority: "context", ...(actor ? { actor } : undefined) },
    isRunActor: false,
  };
}

const throwingExtractionModel: PluginModel = {
  async completeObject() {
    throw new Error("memory extraction should not run");
  },
};

function slackContext(
  overrides: {
    channelId?: string;
    teamId?: string;
    threadTs?: string;
    userId?: string;
  } = {},
) {
  const teamId = overrides.teamId ?? "T123";
  const channelId = overrides.channelId ?? "C123";
  const threadTs = overrides.threadTs ?? "1718800000.000000";
  return {
    conversationId: `slack:${channelId}:${threadTs}`,
    actor: {
      platform: "slack" as const,
      teamId,
      userId: overrides.userId ?? "U123",
    },
    source: createSlackSource({
      teamId,
      channelId,
      // The Slack boundary supplies normalized public visibility for these
      // C-prefixed test channels unless a test overrides the channel id.
      visibility: channelId.startsWith("C") ? "public" : "private",
      messageTs: threadTs,
      threadTs,
    }),
  };
}

function slackDestination(context: ReturnType<typeof slackContext>) {
  return {
    platform: "slack" as const,
    teamId: context.source.teamId,
    channelId: context.source.channelId,
  };
}

function apiContext(
  overrides: {
    conversationId?: string;
    email?: string;
    userId?: string;
    visibility?: "public" | "private";
  } = {},
) {
  const conversationId =
    overrides.conversationId ?? "local:web:memory-dashboard";
  const email = overrides.email ?? "memory@example.com";
  return {
    conversationId,
    actor: {
      platform: "web" as const,
      userId: overrides.userId ?? `dashboard:${email}`,
      email,
    },
    source: createWebSource(conversationId, overrides.visibility ?? "public"),
  };
}

function localContext(
  overrides: { conversationId?: string; userId?: string } = {},
) {
  const conversationId = overrides.conversationId ?? "local:junior:memory-test";
  return {
    conversationId,
    actor: {
      platform: "local" as const,
      userId: overrides.userId ?? "local-user",
    },
    source: createLocalSource(conversationId),
  };
}

type MemoryTaskContext = PluginTaskContext;

function completedRun(
  overrides: Partial<
    Awaited<ReturnType<MemoryTaskContext["run"]["load"]>>
  > = {},
): NonNullable<Awaited<ReturnType<MemoryTaskContext["run"]["load"]>>> {
  const runtime = localContext();
  return {
    completedAtMs: TEST_NOW_MS,
    conversationId: runtime.conversationId,
    destination: {
      platform: "local",
      conversationId: runtime.conversationId,
    },
    transcript: [
      instructionMessage("I prefer terse PR summaries."),
      {
        type: "message",
        role: "assistant",
        text: "Got it.",
      },
    ],
    actor: runtime.actor,
    actors: [runtime.actor],
    runId: "local-turn-1",
    source: runtime.source,
    ...overrides,
  };
}

function processSessionContext(
  overrides: Partial<MemoryTaskContext> = {},
): MemoryTaskContext {
  const run =
    overrides.run ??
    ({
      async load() {
        return completedRun();
      },
    } satisfies MemoryTaskContext["run"]);
  return {
    db: overrides.db ?? {},
    embedder: overrides.embedder ?? createTestEmbedder(),
    events:
      overrides.events ??
      ({
        async emit() {},
      } satisfies MemoryTaskContext["events"]),
    id: "plugin-task-memory",
    log: noopLogger,
    model:
      overrides.model ??
      extractionModel([
        {
          kind: "preference",
          content: "terse PR summaries",
        },
      ]).model,
    name: "processSession",
    plugin: { name: "memory" },
    run,
    state: memoryState,
    ...overrides,
  };
}

function testCanonicalContent(content: string): string {
  return content.replace(/^I prefer /, "Prefers ").replace(/^I use /, "Uses ");
}

function allowMemory(
  target: "actor" | "conversation",
  onRequest?: (request: CreateMemoryRequest) => void,
): MemoryReviewer {
  return {
    reviewCreateRequest(candidate) {
      onRequest?.(candidate);
      return {
        decision: "store",
        kind: target === "actor" ? "preference" : "knowledge",
        content: testCanonicalContent(candidate.content),
        ...(candidate.expiresAtMs !== undefined
          ? { expiresAtMs: candidate.expiresAtMs }
          : undefined),
      };
    },
  };
}

const rejectMemory: MemoryReviewer = {
  reviewCreateRequest() {
    return {
      decision: "reject",
      reason: "not_public_shareable",
    };
  },
};

describe("memory plugin storage", () => {
  it("normalizes structured review responses", async () => {
    const calls: Parameters<PluginModel["completeObject"]>[0][] = [];
    const model: PluginModel = {
      async completeObject(input) {
        calls.push(input);
        return {
          object: {
            decision: "store",
            kind: "preference",
            canonicalFact: "Uses qa-structured-output in CLI QA.",
            expiresAtMs: null,
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    await expect(
      agent.reviewCreateRequest({
        content: "I use qa-structured-output in CLI QA.",
        runtimeContext: localContext(),
      }),
    ).resolves.toEqual({
      decision: "store",
      kind: "preference",
      content: "Uses qa-structured-output in CLI QA.",
    });
    expect(calls[0]?.schema).toBeDefined();
  });

  it("normalizes recall selection to known unique candidate ids", async () => {
    const calls: Parameters<PluginModel["completeObject"]>[0][] = [];
    const model: PluginModel = {
      async completeObject(input) {
        calls.push(input);
        return {
          costUsd: 0.0042,
          object: {
            relevantIds: ["memory-2", "unknown", "memory-2", "memory-1"],
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    await expect(
      agent.selectRelevantMemories({
        candidates: [
          { content: "Release notes live in Notion.", id: "memory-1" },
          {
            content: "getsentry/junior CI runs package tests with pnpm.",
            id: "memory-2",
          },
        ],
        userRequest: "How does CI work in getsentry/junior?",
      }),
    ).resolves.toEqual({
      costUsd: 0.0042,
      relevantIds: ["memory-2", "memory-1"],
    });
    expect(calls[0]?.system).toContain(
      "Reject memories that merely share a company",
    );
    expect(calls[0]?.prompt).toContain("<candidate-memories>");
  });

  it("registers explicit model id as memory plugin model configuration", () => {
    const plugin = memoryPlugin({
      modelId: "anthropic/claude-sonnet-4.6",
    });

    expect(plugin.model).toEqual({
      structuredModelId: "anthropic/claude-sonnet-4.6",
    });
  });

  it("defaults memory extraction to the host default model", () => {
    const previousMemoryModel = process.env.AI_MEMORY_MODEL;
    delete process.env.AI_MEMORY_MODEL;

    try {
      const plugin = memoryPlugin();
      expect(plugin.model).toEqual({
        structuredModel: "default",
      });
    } finally {
      if (previousMemoryModel === undefined) {
        delete process.env.AI_MEMORY_MODEL;
      } else {
        process.env.AI_MEMORY_MODEL = previousMemoryModel;
      }
    }
  });

  it("configures automatic recall and passive extraction independently", () => {
    const defaults = memoryPlugin();
    expect(defaults.hooks?.userPrompt).toBeTypeOf("function");
    expect(defaults.tasks?.processSession).toBeDefined();

    const withoutRecall = memoryPlugin({ disableRecall: true });
    expect(withoutRecall.hooks?.userPrompt).toBeUndefined();
    expect(withoutRecall.tasks?.processSession).toBeDefined();

    const withoutExtraction = memoryPlugin({ disableExtraction: true });
    expect(withoutExtraction.hooks?.userPrompt).toBeTypeOf("function");
    expect(withoutExtraction.tasks?.processSession).toBeUndefined();

    const withoutEither = memoryPlugin({
      disableExtraction: true,
      disableRecall: true,
    });
    expect(withoutEither.hooks?.userPrompt).toBeUndefined();
    expect(withoutEither.tasks?.processSession).toBeUndefined();
  });

  it("parses canonical actor extraction into stored memory text", async () => {
    const model: PluginModel = {
      async completeObject() {
        return {
          object: {
            memories: [
              {
                canonicalFact:
                  "Prefers causes before mitigations in incident writeups.",
                expiresAtMs: null,
                kind: "preference",
                evidenceMessageIndices: [0],
              },
            ],
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    await expect(
      agent.extractSessionMemories({
        transcript: [
          {
            type: "message",
            role: "user",
            text: "For incident writeups, causes go before mitigations.",
          },
          {
            type: "message",
            role: "assistant",
            text: "Got it.",
          },
        ],
        actors: [localContext().actor],
        runtimeContext: localContext(),
      }),
    ).resolves.toEqual({
      memories: [
        {
          content: "Prefers causes before mitigations in incident writeups.",
          expiresAtMs: null,
          kind: "preference",
          evidenceMessageIndices: [0],
        },
      ],
    });
  });

  it("accepts up to five passive extraction memories", async () => {
    const model: PluginModel = {
      async completeObject() {
        return {
          object: {
            memories: [
              {
                canonicalFact: "Fact one.",
                expiresAtMs: null,
                kind: "knowledge",
                evidenceMessageIndices: [0],
              },
              {
                canonicalFact: "Fact two.",
                expiresAtMs: null,
                kind: "knowledge",
                evidenceMessageIndices: [0],
              },
              {
                canonicalFact: "Prefers one.",
                expiresAtMs: null,
                kind: "preference",
                evidenceMessageIndices: [0],
              },
              {
                canonicalFact: "Prefers two.",
                expiresAtMs: null,
                kind: "preference",
                evidenceMessageIndices: [0],
              },
              {
                canonicalFact: "Procedure one.",
                expiresAtMs: null,
                kind: "procedure",
                evidenceMessageIndices: [0],
              },
            ],
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    const result = await agent.extractSessionMemories({
      transcript: [
        {
          type: "message",
          role: "user",
          text: "Store several durable facts.",
        },
      ],
      actors: [localContext().actor],
      runtimeContext: localContext(),
    });

    expect(result.memories).toHaveLength(5);
  });

  it("rejects passive extraction responses with more than five memories", async () => {
    const model: PluginModel = {
      async completeObject() {
        return {
          object: {
            memories: Array.from({ length: 6 }, (_, index) => ({
              canonicalFact: `Fact ${index + 1}.`,
              expiresAtMs: null,
              kind: "knowledge",
              evidenceMessageIndices: [0],
            })),
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    await expect(
      agent.extractSessionMemories({
        transcript: [
          {
            type: "message",
            role: "user",
            text: "Store several durable facts.",
          },
        ],
        actors: [localContext().actor],
        runtimeContext: localContext(),
      }),
    ).rejects.toThrow("Too big");
  });

  it("uses AI_MEMORY_MODEL as the memory plugin model default", async () => {
    const previousModel = process.env.AI_MEMORY_MODEL;
    process.env.AI_MEMORY_MODEL = "anthropic/claude-sonnet-4.6";

    try {
      const plugin = memoryPlugin();
      expect(plugin.model).toEqual({
        structuredModelId: "anthropic/claude-sonnet-4.6",
      });
    } finally {
      if (previousModel === undefined) {
        delete process.env.AI_MEMORY_MODEL;
      } else {
        process.env.AI_MEMORY_MODEL = previousModel;
      }
    }
  });

  it("normalizes structured rejection responses", async () => {
    const model: PluginModel = {
      async completeObject() {
        return {
          object: {
            decision: "reject",
            reason: "not_public_shareable",
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    await expect(
      agent.reviewCreateRequest({
        content: "remember this",
        runtimeContext: localContext(),
      }),
    ).resolves.toEqual({
      decision: "reject",
      reason: "not_public_shareable",
    });
  });

  it("extracts and stores accepted memories from completed sessions", async () => {
    const fixture = await createMemoryFixture();

    try {
      const emitted: Parameters<MemoryTaskContext["events"]["emit"]>[0][] = [];
      const { model } = extractionModel(
        [
          {
            kind: "preference",
            content: "Prefers QA notes that mention database row checks.",
          },
          {
            content: "Deploy runbooks live in Notion.",
            kind: "knowledge",
          },
        ],
        0.0042,
      );
      const embedder = createTestEmbedder();

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          embedder,
          events: {
            async emit(event) {
              emitted.push(event);
            },
          },
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  instructionMessage(
                    "I prefer QA notes that mention database row checks. Deploy runbooks live in Notion.",
                  ),
                  {
                    type: "message",
                    role: "assistant",
                    text: "I will keep that in mind.",
                  },
                ],
              });
            },
          },
        }),
      );

      const rows = await memoryDb(fixture)
        .select()
        .from(memorySqlSchema.juniorMemoryMemories)
        .orderBy(memorySqlSchema.juniorMemoryMemories.createdAtMs);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: "Prefers QA notes that mention database row checks.",
            scope: "private",
            sourcePlatform: "local",
            subjectType: "user",
            kind: "preference",
          }),
          expect.objectContaining({
            content: "Deploy runbooks live in Notion.",
            scope: "private",
            sourcePlatform: "local",
            subjectType: "conversation",
            kind: "knowledge",
          }),
        ]),
      );
      expect(rows).toHaveLength(2);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.data).toEqual({
        costUsd: 0.0042,
        memories: expect.arrayContaining([
          expect.objectContaining({
            content: "Prefers QA notes that mention database row checks.",
            kind: "preference",
            scope: "private",
          }),
          expect.objectContaining({
            content: "Deploy runbooks live in Notion.",
            kind: "knowledge",
            scope: "private",
          }),
        ]),
      });
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryEmbeddings)
          .orderBy(memorySqlSchema.juniorMemoryEmbeddings.memoryId),
      ).resolves.toEqual(
        expect.arrayContaining(
          rows.map((row) =>
            expect.objectContaining({
              dimensions: TEST_EMBEDDING_DIMENSIONS,
              memoryId: row.id,
              metric: "cosine",
              model: "test-embedding-model",
              provider: "test-embedding-provider",
            }),
          ),
        ),
      );
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("records empty extraction cost without capturing memories", async () => {
    const fixture = await createMemoryFixture();

    try {
      const emitted: Parameters<MemoryTaskContext["events"]["emit"]>[0][] = [];
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          events: {
            async emit(event) {
              emitted.push(event);
            },
          },
          model: extractionModel([], 0.0017).model,
        }),
      );

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.data).toEqual({ costUsd: 0.0017, memories: [] });
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("supersedes old preferences from passive completed-session extraction", async () => {
    const fixture = await createMemoryFixture();

    try {
      const store = createMemoryStore(memoryDb(fixture), localContext(), {
        now: () => TEST_NOW_MS,
      });
      const oldMemory = await store.createMemory({
        content: "Prefers Python for automation scripts.",
        kind: "preference",
        idempotencyKey: "memory-test:passive-supersession-old",
      });
      const model: PluginModel = {
        async completeObject(input) {
          if (
            typeof input.prompt === "string" &&
            input.prompt.includes("<memory-preference-adjudication-input>")
          ) {
            return {
              object: {
                decision: "supersedes_old",
                supersededIds: [oldMemory.memory.id],
              },
            };
          }
          return {
            object: {
              memories: [
                {
                  canonicalFact: "Prefers TypeScript for automation scripts.",
                  expiresAtMs: null,
                  kind: "preference",
                  evidenceMessageIndices: [0],
                },
              ],
            },
          };
        },
      };

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  instructionMessage(
                    "Actually, I prefer TypeScript for automation scripts.",
                  ),
                  {
                    type: "message",
                    role: "assistant",
                    text: "Noted.",
                  },
                ],
              });
            },
          },
        }),
      );

      const rows = await memoryDb(fixture)
        .select()
        .from(memorySqlSchema.juniorMemoryMemories)
        .orderBy(memorySqlSchema.juniorMemoryMemories.createdAtMs);
      const newMemory = rows.find((row) => row.content.includes("TypeScript"));
      expect(newMemory).toBeDefined();
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: oldMemory.memory.id,
            supersededAtMs: expect.any(Number),
            supersededById: newMemory!.id,
          }),
          expect.objectContaining({
            content: "Prefers TypeScript for automation scripts.",
            scope: "private",
            supersededAtMs: null,
            supersededById: null,
          }),
        ]),
      );
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("stores extracted conversation memories from completed sessions with tool results", async () => {
    const fixture = await createMemoryFixture();

    try {
      const model: PluginModel = {
        async completeObject(input) {
          if (
            typeof input.prompt !== "string" ||
            !input.prompt.includes("queryAnalyticsCatalog") ||
            !input.prompt.includes(
              "The modeled warehouse cohort table is the source of truth for signup funnel analysis.",
            )
          ) {
            return { object: { memories: [] } };
          }
          return {
            object: {
              memories: [
                {
                  canonicalFact:
                    "Signup funnel analysis should use the modeled warehouse cohort table.",
                  expiresAtMs: null,
                  kind: "procedure",
                  evidenceMessageIndices: [1],
                },
              ],
            },
          };
        },
      };

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  {
                    type: "message",
                    role: "user",
                    text: "Where should signup funnel analysis come from?",
                  },
                  {
                    type: "toolResult",
                    toolName: "queryAnalyticsCatalog",
                    isError: false,
                    text: "The modeled warehouse cohort table is the source of truth for signup funnel analysis.",
                  },
                  {
                    type: "message",
                    role: "assistant",
                    text: "Use the modeled warehouse cohort table.",
                  },
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content:
            "Signup funnel analysis should use the modeled warehouse cohort table.",
          scope: "private",
          subjectType: "conversation",
          kind: "procedure",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("reuses cached extraction output across task retries", async () => {
    const fixture = await createMemoryFixture();

    try {
      const state = createMemoryState();
      const emitted: Parameters<MemoryTaskContext["events"]["emit"]>[0][] = [];
      const { model } = extractionModel(
        [
          {
            content: "Prefers retry-safe memory extraction.",
            kind: "preference",
          },
        ],
        0.0023,
      );
      const run = {
        async load() {
          return completedRun({
            transcript: [
              instructionMessage("I prefer retry-safe memory extraction."),
            ],
          });
        },
      };

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          events: {
            async emit(event) {
              emitted.push(event);
            },
          },
          model,
          run,
          state,
        }),
      );
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          events: {
            async emit(event) {
              emitted.push(event);
            },
          },
          model: {
            async completeObject() {
              throw new Error("model should not run on cached retry");
            },
          },
          run,
          state,
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Prefers retry-safe memory extraction.",
          scope: "private",
          kind: "preference",
        }),
      ]);
      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.data).toEqual(emitted[0]?.data);
      expect(emitted[0]?.data).toMatchObject({ costUsd: 0.0023 });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("re-extracts when cached extraction output predates evidence citations", async () => {
    const fixture = await createMemoryFixture();

    try {
      const state = createMemoryState();
      await state.set("memory-extraction:stale-cache-task", [
        {
          content: "Stale cache content should not be stored.",
          expiresAtMs: null,
          kind: "knowledge",
        },
      ]);
      const { calls, model } = extractionModel([
        {
          content: "Fresh extraction content is stored.",
          kind: "knowledge",
          evidenceMessageIndices: [0],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          id: "stale-cache-task",
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  instructionMessage("Fresh extraction content is stored."),
                ],
              });
            },
          },
          state,
        }),
      );

      expect(calls).toHaveLength(1);
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Fresh extraction content is stored.",
          scope: "private",
          kind: "knowledge",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps passive extraction idempotency distinct by memory kind", async () => {
    const fixture = await createMemoryFixture();

    try {
      const { model } = extractionModel([
        {
          content: "Memory classification compatibility is important.",
          kind: "procedure",
        },
        {
          content: "Memory classification compatibility is important.",
          kind: "knowledge",
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  instructionMessage(
                    "Memory classification compatibility is important.",
                  ),
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .orderBy(memorySqlSchema.juniorMemoryMemories.kind),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Memory classification compatibility is important.",
          kind: "knowledge",
        }),
        expect.objectContaining({
          content: "Memory classification compatibility is important.",
          kind: "procedure",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("skips passive extraction for successful memory mutation tool turns", async () => {
    const fixture = await createMemoryFixture();

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model: throwingExtractionModel,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  {
                    type: "message",
                    role: "user",
                    text: "Remember that I prefer duplicate memory avoidance.",
                  },
                  {
                    type: "toolResult",
                    toolName: "createMemory",
                    isError: false,
                    text: "Memory saved.",
                  },
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("re-emits captured memories when a task retry finds its idempotent writes", async () => {
    const fixture = await createMemoryFixture();
    try {
      const emitted: Parameters<MemoryTaskContext["events"]["emit"]>[0][] = [];
      const context = processSessionContext({
        db: memoryDb(fixture),
        events: {
          async emit(event) {
            emitted.push(event);
          },
        },
        model: extractionModel([
          {
            kind: "preference",
            content: "Prefers retry-safe memory transcript events.",
          },
        ]).model,
        run: {
          async load() {
            return completedRun({
              transcript: [
                instructionMessage(
                  "I prefer retry-safe memory transcript events.",
                ),
              ],
            });
          },
        },
      });

      await processMemorySession(context);
      await processMemorySession(context);

      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.data).toEqual(emitted[0]?.data);
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("keeps captured event data stable when retries include an exact duplicate", async () => {
    const fixture = await createMemoryFixture();
    try {
      const duplicateContent = "Deployment runbooks live in Notion.";
      const store = createMemoryStore(memoryDb(fixture), localContext(), {
        now: () => TEST_NOW_MS,
      });
      await store.createConversationMemory({
        content: duplicateContent,
        idempotencyKey: "memory-test:existing-conversation-fact",
        kind: "knowledge",
      });
      const emitted: Parameters<MemoryTaskContext["events"]["emit"]>[0][] = [];
      let failFirstEmit = true;
      const context = processSessionContext({
        db: memoryDb(fixture),
        events: {
          async emit(event) {
            emitted.push(event);
            if (failFirstEmit) {
              failFirstEmit = false;
              throw new Error("event append failed");
            }
          },
        },
        model: extractionModel([
          {
            kind: "preference",
            content: "Prefers stable memory event retries.",
          },
          {
            kind: "knowledge",
            content: duplicateContent,
          },
        ]).model,
        run: {
          async load() {
            return completedRun({
              transcript: [
                instructionMessage(
                  `I prefer stable memory event retries. ${duplicateContent}`,
                ),
              ],
            });
          },
        },
      });

      await expect(processMemorySession(context)).rejects.toThrow(
        "event append failed",
      );
      await processMemorySession(context);

      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.data).toEqual(emitted[0]?.data);
      expect(emitted[0]?.data).toMatchObject({
        memories: [
          expect.objectContaining({
            content: "Prefers stable memory event retries.",
            kind: "preference",
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  it("emits only the final active preference after same-batch supersession", async () => {
    const fixture = await createMemoryFixture();
    try {
      const firstContent = "Prefers Python for automation scripts.";
      const finalContent = "Prefers TypeScript for automation scripts.";
      const emitted: Parameters<MemoryTaskContext["events"]["emit"]>[0][] = [];
      let failFirstEmit = true;
      const model: PluginModel = {
        async completeObject(input) {
          if (
            typeof input.prompt === "string" &&
            input.prompt.includes("<memory-preference-adjudication-input>")
          ) {
            const existingJson =
              /<existing-memories>\n(.+)\n<\/existing-memories>/s.exec(
                input.prompt,
              )?.[1];
            const existing = existingJson
              ? (JSON.parse(existingJson) as Array<{ id: string }>)
              : [];
            if (existing.length === 0) {
              return { object: { decision: "distinct" } };
            }
            return {
              object: {
                decision: "supersedes_old",
                supersededIds: [existing[0]!.id],
              },
            };
          }
          return {
            object: {
              memories: [
                {
                  canonicalFact: firstContent,
                  expiresAtMs: null,
                  kind: "preference",
                  evidenceMessageIndices: [0],
                },
                {
                  canonicalFact: finalContent,
                  expiresAtMs: null,
                  kind: "preference",
                  evidenceMessageIndices: [0],
                },
              ],
            },
          };
        },
      };
      const context = processSessionContext({
        db: memoryDb(fixture),
        events: {
          async emit(event) {
            emitted.push(event);
            if (failFirstEmit) {
              failFirstEmit = false;
              throw new Error("event append failed");
            }
          },
        },
        model,
        run: {
          async load() {
            return completedRun({
              transcript: [
                instructionMessage(
                  "I first preferred Python, but now I prefer TypeScript for automation scripts.",
                ),
              ],
            });
          },
        },
      });

      await expect(processMemorySession(context)).rejects.toThrow(
        "event append failed",
      );
      await processMemorySession(context);

      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.data).toEqual(emitted[0]?.data);
      expect(emitted[0]?.data).toMatchObject({
        memories: [
          expect.objectContaining({
            content: finalContent,
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  it("skips passive extraction for memory recall tool turns", async () => {
    const fixture = await createMemoryFixture();
    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model: throwingExtractionModel,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  {
                    type: "message",
                    role: "user",
                    text: "I prefer recall turns to still learn durable facts.",
                  },
                  {
                    type: "toolResult",
                    toolName: "searchMemories",
                    isError: false,
                    text: "No matching memories found.",
                  },
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("stores passive extraction in its private Slack domain", async () => {
    const fixture = await createMemoryFixture();
    const privateContext = slackContext({ channelId: "D123" });
    const { model } = extractionModel([
      {
        content: "Prefers private Slack memory.",
        kind: "preference",
      },
    ]);

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                conversationId: "slack:D123:1718800000.000000",
                destination: slackDestination(privateContext),
                transcript: [
                  instructionMessage(
                    "I prefer private Slack memory.",
                    privateContext.actor,
                  ),
                ],
                actor: privateContext.actor,
                actors: [privateContext.actor],
                source: privateContext.source,
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Prefers private Slack memory.",
          scope: "private",
          scopeKey: "slack:T123:D123",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("stores actor memories from public web completed sessions", async () => {
    const fixture = await createMemoryFixture();
    const { model } = extractionModel([
      {
        kind: "preference",
        content: "Prefers short dashboard answers.",
      },
    ]);
    const runtime = apiContext({
      conversationId: "local:web:memory-public-dashboard",
      email: "dashboard@example.com",
      visibility: "public",
    });

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                conversationId: runtime.conversationId,
                destination: {
                  platform: "local",
                  conversationId: runtime.conversationId,
                },
                transcript: [
                  instructionMessage("I prefer short dashboard answers."),
                ],
                actor: runtime.actor,
                actors: [runtime.actor],
                source: runtime.source,
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toMatchObject([
        {
          content: "Prefers short dashboard answers.",
          scope: "public",
          scopeKey: "public",
          sourceKey: runtime.conversationId,
          sourcePlatform: "web",
          subjectKey: "junior:dashboard@example.com",
          kind: "preference",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("stores explicit web memory as public when its source is public", async () => {
    const fixture = await createMemoryFixture();
    const runtime = apiContext({ email: "dashboard@example.com" });

    try {
      await installViewerCoreTables(fixture);
      const store = createMemoryStore(memoryDb(fixture), runtime, {
        now: () => TEST_NOW_MS,
      });
      const created = await store.createMemory({
        content: "Prefers short dashboard answers.",
        idempotencyKey: "tool:api:personal-scope",
        kind: "preference",
      });

      expect(created.memory).toMatchObject({
        scope: "public",
        subjectType: "user",
      });
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toMatchObject([
        {
          id: created.memory.id,
          scope: "public",
          scopeKey: "public",
          sourceKey: runtime.conversationId,
          sourcePlatform: "web",
          subjectKey: "junior:dashboard@example.com",
          subjectType: "user",
        },
      ]);

      const listed = await createViewerMemories(memoryDb(fixture), {
        email: "dashboard@example.com",
        id: "dashboard-viewer",
        identities: [],
      }).list({ limit: 10 });
      expect(listed.memories.map((memory) => memory.id)).toEqual([
        created.memory.id,
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("skips passive extraction for Slack sessions without a message key", async () => {
    const fixture = await createMemoryFixture();
    const runtime = slackContext();

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model: throwingExtractionModel,
          run: {
            async load() {
              return completedRun({
                conversationId: "slack:C123:missing-message-key",
                destination: slackDestination(runtime),
                transcript: [
                  {
                    type: "message",
                    role: "user",
                    text: "I prefer Slack message key validation.",
                  },
                ],
                actor: runtime.actor,
                source: createSlackSource({
                  teamId: runtime.source.teamId,
                  channelId: runtime.source.channelId,

                  visibility: "private",
                }),
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("stores actor memories from local completed sessions", async () => {
    const fixture = await createMemoryFixture();
    const { model } = extractionModel([
      {
        kind: "preference",
        content: "Prefers local passive memory QA.",
      },
    ]);
    const runtime = localContext();

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                conversationId: runtime.conversationId,
                destination: {
                  platform: "local",
                  conversationId: runtime.conversationId,
                },
                transcript: [
                  instructionMessage("I prefer local passive memory QA."),
                ],
                actor: runtime.actor,
                source: runtime.source,
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toMatchObject([
        {
          content: "Prefers local passive memory QA.",
          scope: "private",
          subjectKey: "local:local-user",
          kind: "preference",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("stores conversation memories without actor context", async () => {
    const fixture = await createMemoryFixture();
    const { model } = extractionModel([
      {
        kind: "procedure",
        content: "Release triage checks deployment markers first.",
      },
      {
        kind: "preference",
        content: "Prefers actor-only memory.",
      },
    ]);
    const runtime = localContext();

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                conversationId: runtime.conversationId,
                destination: {
                  platform: "local",
                  conversationId: runtime.conversationId,
                },
                actor: undefined,
                transcript: [
                  contextMessage(
                    "For release triage, check deployment markers first.",
                    {
                      platform: "slack",
                      teamId: "T123",
                      userId: "U_OTHER",
                    },
                  ),
                ],
                source: runtime.source,
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Release triage checks deployment markers first.",
          scope: "private",
          subjectType: "conversation",
          kind: "procedure",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("stores Slack conversation memories for system runs", async () => {
    const fixture = await createMemoryFixture();
    const actor = { platform: "system" as const, name: "scheduler" };
    const { model } = extractionModel([
      {
        kind: "preference",
        content: "Prefers concise deployment notes.",
      },
      {
        kind: "knowledge",
        content: "Production deploys require a release marker.",
      },
    ]);
    const runtime = slackContext();

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                conversationId: runtime.conversationId,
                destination: slackDestination(runtime),
                actor,
                actors: [actor],
                transcript: [
                  instructionMessage(
                    "I prefer concise deployment notes. Production deploys require a release marker.",
                    actor,
                  ),
                ],
                source: runtime.source,
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Production deploys require a release marker.",
          scope: "public",
          sourcePlatform: "slack",
          subjectType: "conversation",
          kind: "knowledge",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("stores a personal preference when every cited entry is a run-actor instruction", async () => {
    const fixture = await createMemoryFixture();

    try {
      const { model } = extractionModel([
        {
          kind: "preference",
          content: "Prefers concise standup notes.",
          evidenceMessageIndices: [0, 1],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  instructionMessage("I prefer concise standup notes."),
                  instructionMessage("Keep standup notes short."),
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Prefers concise standup notes.",
          scope: "private",
          kind: "preference",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("drops a cached passive preference when the completed run has multiple actors", async () => {
    const fixture = await createMemoryFixture();

    try {
      const state = createMemoryState();
      const secondActor: Actor = {
        platform: "local",
        userId: "local-user-2",
      };
      // Seed the extraction cache with a preference proposed before the
      // multi-actor gate existed. The routing gate must still drop it on replay.
      await state.set("memory-extraction:multi-actor-task", [
        {
          content: "Prefers concise standup notes.",
          expiresAtMs: null,
          kind: "preference",
          evidenceMessageIndices: [0],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          id: "multi-actor-task",
          model: throwingExtractionModel,
          run: {
            async load() {
              return completedRun({
                actors: [localInstructionActor, secondActor],
                transcript: [
                  instructionMessage("I prefer concise standup notes."),
                ],
              });
            },
          },
          state,
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("drops a passive preference when the completed run has no attributed actors", async () => {
    const fixture = await createMemoryFixture();

    try {
      const { model } = extractionModel([
        {
          kind: "preference",
          content: "Prefers weekly digests.",
          evidenceMessageIndices: [0],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                actors: [],
                transcript: [instructionMessage("I prefer weekly digests.")],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("drops a passive preference when a cited entry is context authority", async () => {
    const fixture = await createMemoryFixture();

    try {
      const { model } = extractionModel([
        {
          kind: "preference",
          content: "Prefers dark mode dashboards.",
          evidenceMessageIndices: [0],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  contextMessage("Someone in the channel likes dark mode."),
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("drops a passive preference when a cited entry lacks provenance", async () => {
    const fixture = await createMemoryFixture();

    try {
      const { model } = extractionModel([
        {
          kind: "preference",
          content: "Prefers weekly digests.",
          evidenceMessageIndices: [0],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [
                  {
                    type: "message",
                    role: "user",
                    text: "I prefer weekly digests.",
                  },
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("stores conversation knowledge cited to a context-authority message", async () => {
    const fixture = await createMemoryFixture();

    try {
      const { model } = extractionModel([
        {
          kind: "knowledge",
          content: "Deploy runbooks live in Notion.",
          evidenceMessageIndices: [0],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [contextMessage("Deploy runbooks live in Notion.")],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Deploy runbooks live in Notion.",
          scope: "private",
          subjectType: "conversation",
          kind: "knowledge",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("stores conversation knowledge cited to a non-run-actor instruction message", async () => {
    const fixture = await createMemoryFixture();

    try {
      const runtime = slackContext({ userId: "U_ALICE" });
      const bob = {
        platform: "slack" as const,
        teamId: runtime.source.teamId,
        userId: "U_BOB",
        userName: "bob",
      };
      const { model } = extractionModel([
        {
          kind: "knowledge",
          content: "Deploy runbooks live in Notion.",
          evidenceMessageIndices: [0],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                actor: runtime.actor,
                conversationId: runtime.conversationId,
                destination: slackDestination(runtime),
                source: runtime.source,
                transcript: [
                  nonRunActorInstructionMessage(
                    "Bob said deploy runbooks live in Notion.",
                    bob,
                  ),
                ],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Deploy runbooks live in Notion.",
          scope: "public",
          subjectType: "conversation",
          kind: "knowledge",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("drops an extracted memory that cites an out-of-range transcript index", async () => {
    const fixture = await createMemoryFixture();

    try {
      const { model } = extractionModel([
        {
          kind: "preference",
          content: "Prefers monospaced fonts.",
          evidenceMessageIndices: [5],
        },
      ]);

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model,
          run: {
            async load() {
              return completedRun({
                transcript: [instructionMessage("I prefer monospaced fonts.")],
              });
            },
          },
        }),
      );

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryMemories),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("persists, recalls, and archives visible memories", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const publicStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });
      const publicMemory = await publicStore.createConversationMemory({
        content: "Deploy runbooks live in Notion.",
        kind: "knowledge",
        idempotencyKey: "memory-test:public",
      });
      nowMs += 1;
      const privateContext = slackContext({ channelId: "D123" });
      const privateStore = createMemoryStore(
        memoryDb(fixture),
        privateContext,
        {
          now: () => nowMs,
        },
      );
      const privateMemory = await privateStore.createMemory({
        content: "Prefers short PR summaries.",
        kind: "preference",
        idempotencyKey: "memory-test:private",
      });

      expect(publicMemory.memory).toMatchObject({
        scope: "public",
        subjectType: "conversation",
      });
      expect(privateMemory.memory).toMatchObject({
        scope: "private",
        subjectType: "user",
      });
      await expect(privateStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: privateMemory.memory.id }),
        expect.objectContaining({ id: publicMemory.memory.id }),
      ]);
      await expect(privateStore.listPrivateMemories({})).resolves.toEqual([
        expect.objectContaining({ id: privateMemory.memory.id }),
      ]);

      const sameDomainStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "D123", userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(sameDomainStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: privateMemory.memory.id }),
        expect.objectContaining({ id: publicMemory.memory.id }),
      ]);

      const otherDomainStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({
          channelId: "D999",
          threadTs: "1718800001.000000",
          userId: "U456",
        }),
        { now: () => nowMs },
      );
      await expect(otherDomainStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: publicMemory.memory.id }),
      ]);
      const otherTeamStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ teamId: "T999", userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(otherTeamStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: publicMemory.memory.id }),
      ]);
      await expect(
        otherDomainStore.archiveMemory({ id: privateMemory.memory.id }),
      ).rejects.toThrow("Memory was not found in the current context.");
      await expect(
        publicStore.archiveMemory({ id: publicMemory.memory.id }),
      ).rejects.toThrow("Memory was not found in the current context.");

      nowMs += 1;
      const archived = await privateStore.archiveMemory({
        id: privateMemory.memory.id.slice(0, 12),
      });
      expect(archived).toMatchObject({
        id: privateMemory.memory.id,
        archivedAtMs: nowMs,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("serves public memories through the authenticated REST resource", async () => {
    const fixture = await createMemoryFixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(TEST_NOW_MS);

    try {
      await installViewerCoreTables(fixture);
      const firstContext = slackContext({ teamId: "T123", userId: "U123" });
      const secondContext = slackContext({ teamId: "T456", userId: "U456" });
      const hiddenContext = slackContext({ teamId: "T999", userId: "U999" });
      const privateContext = slackContext({
        channelId: "D777",
        teamId: "T123",
        userId: "U123",
      });
      const firstStore = createMemoryStore(memoryDb(fixture), firstContext, {
        now: () => TEST_NOW_MS,
      });
      const secondStore = createMemoryStore(memoryDb(fixture), secondContext, {
        now: () => TEST_NOW_MS + 1,
      });
      const hiddenStore = createMemoryStore(memoryDb(fixture), hiddenContext, {
        now: () => TEST_NOW_MS + 2,
      });
      const privateStore = createMemoryStore(
        memoryDb(fixture),
        privateContext,
        { now: () => TEST_NOW_MS + 3 },
      );
      const first = await firstStore.createMemory({
        content: "Prefers concise release notes.",
        idempotencyKey: "tool:api:first",
        kind: "preference",
      });
      const second = await secondStore.createMemory({
        content: "Deploy runbooks live in Notion.",
        idempotencyKey: "session:api:second",
        kind: "knowledge",
      });
      const hidden = await hiddenStore.createMemory({
        content: "Hidden viewer memory.",
        idempotencyKey: "api:hidden",
        kind: "knowledge",
      });
      const publicMemory = await firstStore.createConversationMemory({
        content: "Public workspace memory.",
        idempotencyKey: "session:api:public",
        kind: "knowledge",
      });
      await privateStore.createConversationMemory({
        content: "Private conversation memory.",
        idempotencyKey: "session:api:private",
        kind: "knowledge",
      });
      const api = createMemoryApi({
        db: memoryDb(fixture),
        eventStats: {
          async costsByDay({ days, eventName }) {
            const start = Date.parse("2026-04-30T00:00:00.000Z");
            return Array.from({ length: days }, (_, index) => ({
              costUsd:
                index === days - 1
                  ? eventName === "memories_recalled"
                    ? 0.0011
                    : 0.0042
                  : 0,
              date: new Date(start + index * 24 * 60 * 60 * 1_000)
                .toISOString()
                .slice(0, 10),
              events:
                index === days - 1
                  ? eventName === "memories_recalled"
                    ? 3
                    : 1
                  : 0,
            }));
          },
        },
        users: {
          async resolve(email) {
            return { email, id: "api-viewer", identities: [] };
          },
        },
      });
      const requestContext = pluginApiRouteRequestContextSchema.parse({
        auth: {
          user: {
            email: "person@example.com",
            emailVerified: true,
          },
        },
        pluginName: "memory",
      });

      const unknownRouteResponse = await api.fetch(
        new Request("http://localhost/unknown"),
        requestContext,
      );
      expect(unknownRouteResponse.status).toBe(404);
      const invalidMethodResponse = await api.fetch(
        new Request("http://localhost/memories", { method: "POST" }),
        requestContext,
      );
      expect(invalidMethodResponse.status).toBe(405);
      const firstPageResponse = await api.fetch(
        new Request("http://localhost/memories?limit=2"),
        requestContext,
      );
      expect(firstPageResponse.status).toBe(200);
      const firstPage = memoryListResponseSchema.parse(
        await firstPageResponse.json(),
      );
      expect(firstPage.memories).toEqual([
        expect.objectContaining({
          content: "Hidden viewer memory.",
          id: hidden.memory.id,
        }),
        expect.objectContaining({
          content: "Deploy runbooks live in Notion.",
          id: second.memory.id,
        }),
      ]);
      expect(firstPage.nextCursor).toEqual(expect.any(String));

      const secondPageResponse = await api.fetch(
        new Request(
          `http://localhost/memories?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        ),
        requestContext,
      );
      expect(secondPageResponse.status).toBe(200);
      expect(
        memoryListResponseSchema.parse(await secondPageResponse.json()),
      ).toEqual({
        memories: [
          expect.objectContaining({
            id: expect.stringMatching(
              new RegExp(`^(${first.memory.id}|${publicMemory.memory.id})$`),
            ),
          }),
          expect.objectContaining({
            id: expect.stringMatching(
              new RegExp(`^(${first.memory.id}|${publicMemory.memory.id})$`),
            ),
          }),
        ],
      });

      const mismatchedCursorResponse = await api.fetch(
        new Request(
          `http://localhost/memories?q=runbooks&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        ),
        requestContext,
      );
      expect(mismatchedCursorResponse.status).toBe(400);

      const searchResponse = await api.fetch(
        new Request("http://localhost/memories?q=runbooks"),
        requestContext,
      );
      expect(searchResponse.status).toBe(200);
      expect(
        memoryListResponseSchema.parse(await searchResponse.json()).memories,
      ).toEqual([expect.objectContaining({ id: second.memory.id })]);

      const detailResponse = await api.fetch(
        new Request(`http://localhost/memories/${first.memory.id}`),
        requestContext,
      );
      expect(detailResponse.status).toBe(200);
      expect(memoryApiSchema.parse(await detailResponse.json())).toMatchObject({
        content: "Prefers concise release notes.",
        id: first.memory.id,
      });

      const publicDetailResponse = await api.fetch(
        new Request(`http://localhost/memories/${publicMemory.memory.id}`),
        requestContext,
      );
      expect(publicDetailResponse.status).toBe(200);
      expect(
        memoryApiSchema.parse(await publicDetailResponse.json()),
      ).toMatchObject({
        content: "Public workspace memory.",
        id: publicMemory.memory.id,
      });

      const publicDeleteResponse = await api.fetch(
        new Request(`http://localhost/memories/${publicMemory.memory.id}`, {
          method: "DELETE",
        }),
        requestContext,
      );
      expect(publicDeleteResponse.status).toBe(404);

      const dashboardResponse = await api.fetch(
        new Request("http://localhost/dashboard"),
        requestContext,
      );
      expect(dashboardResponse.status).toBe(200);
      const dashboard = memoryDashboardResponseSchema.parse(
        await dashboardResponse.json(),
      );
      expect(dashboard.stats).toMatchObject({
        active: 4,
        automatic: 2,
        explicit: 1,
        knowledge: 3,
        private: 0,
        preference: 1,
        procedure: 0,
        public: 4,
      });
      expect(dashboard.days).toHaveLength(90);
      expect(dashboard.extractionDays.at(-1)).toEqual({
        costUsd: 0.0042,
        date: "2026-07-28",
        events: 1,
      });
      expect(dashboard.recallDays.at(-1)).toEqual({
        costUsd: 0.0011,
        date: "2026-07-28",
        events: 3,
      });
      expect(dashboard.days.find((day) => day.date === "2026-06-19")).toEqual({
        date: "2026-06-19",
        private: 0,
        public: 4,
      });

      const deleteResponse = await api.fetch(
        new Request(`http://localhost/memories/${second.memory.id}`, {
          method: "DELETE",
        }),
        requestContext,
      );
      expect(deleteResponse.status).toBe(404);
      await expect(secondStore.listPrivateMemories({})).resolves.toEqual([]);

      const hiddenDeleteResponse = await api.fetch(
        new Request(`http://localhost/memories/${hidden.memory.id}`, {
          method: "DELETE",
        }),
        requestContext,
      );
      expect(hiddenDeleteResponse.status).toBe(404);
      await expect(hiddenStore.listPrivateMemories({})).resolves.toEqual([]);
    } finally {
      now.mockRestore();
      await fixture.close();
    }
  }, 15_000);

  it("exposes scoped search and explicit show through the plugin CLI command", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = localContext({ userId: "cli-user" });
      const store = createMemoryStore(memoryDb(fixture), context, {
        now: () => TEST_NOW_MS,
      });
      const created = await store.createMemory({
        content: "Prefers CLI memory QA with scoped search.",
        kind: "preference",
        idempotencyKey: "memory-test:cli-search",
      });
      const expired = await store.createMemory({
        content: "Prefers expired CLI memory rows to stay hidden.",
        kind: "preference",
        expiresAtMs: Date.now() - 1,
        idempotencyKey: "memory-test:cli-search-expired",
      });
      const superseded = await store.createMemory({
        content: "Prefers superseded CLI memory rows to stay hidden.",
        kind: "preference",
        idempotencyKey: "memory-test:cli-search-superseded",
      });
      await fixture.execute(
        `
UPDATE junior_memory_memories
SET superseded_at_ms = ${TEST_NOW_MS + 1}
WHERE id = '${superseded.memory.id}'
`,
      );

      const missingScope = await runMemoryCli(fixture, ["search", "memory"]);
      expect(missingScope).toMatchObject({
        exitCode: 1,
        stdout: "",
      });
      expect(missingScope.stderr).toContain("Usage: memory search");
      expect(missingScope.stderr).toContain(
        "error: required option '--scope <scope>' not specified",
      );

      const invalidLimit = await runMemoryCli(fixture, [
        "search",
        "memory",
        "--scope",
        "private",
        "--scope-key",
        "local:junior:memory-test",
        "--limit",
        "many",
      ]);
      expect(invalidLimit).toMatchObject({
        exitCode: 1,
        stdout: "",
      });
      expect(invalidLimit.stderr).toContain("Usage: memory search");
      expect(invalidLimit.stderr).toContain(
        "error: option '--limit <n>' argument 'many' is invalid. --limit must be a number",
      );

      const search = await runMemoryCli(fixture, [
        "search",
        "scoped search",
        "--scope",
        "private",
        "--scope-key",
        "local:junior:memory-test",
      ]);
      expect(search.exitCode).toBe(0);
      expect(search.stderr).toBe("");
      expect(search.stdout).toContain(`id=${created.memory.id}`);
      expect(search.stdout).not.toContain(
        "Prefers CLI memory QA with scoped search.",
      );
      expect(search.stdout).not.toContain("content=");

      const searchWithContent = await runMemoryCli(fixture, [
        "search",
        "scoped search",
        "--scope",
        "private",
        "--scope-key",
        "local:junior:memory-test",
        "--show-content",
      ]);
      expect(searchWithContent.exitCode).toBe(0);
      expect(searchWithContent.stderr).toBe("");
      expect(searchWithContent.stdout).toContain(`id=${created.memory.id}`);
      expect(searchWithContent.stdout).toContain(
        "content=Prefers CLI memory QA with scoped search.",
      );

      const scopedList = await runMemoryCli(fixture, [
        "search",
        "--scope",
        "private",
        "--scope-key",
        "local:junior:memory-test",
      ]);
      expect(scopedList.exitCode).toBe(0);
      expect(scopedList.stderr).toBe("");
      expect(scopedList.stdout).toContain(`id=${created.memory.id}`);
      expect(scopedList.stdout).not.toContain(`id=${expired.memory.id}`);
      expect(scopedList.stdout).not.toContain(`id=${superseded.memory.id}`);

      const show = await runMemoryCli(fixture, ["show", created.memory.id]);
      expect(show.exitCode).toBe(0);
      expect(show.stderr).toBe("");
      expect(show.stdout).toContain(`id=${created.memory.id}`);
      expect(show.stdout).toContain(
        "content=Prefers CLI memory QA with scoped search.",
      );

      const details = await runMemoryCli(fixture, [
        "details",
        created.memory.id,
      ]);
      expect(details.exitCode).toBe(1);
      expect(details.stderr).toContain("error: unknown command 'details'");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("stores derived embeddings and uses vector recall before lexical fallback", async () => {
    const fixture = await createMemoryFixture();

    try {
      const reactMemory = "Uses React hooks for UI state.";
      const mangoMemory = "Favorite CLI QA snack is mango chips.";
      const embedder = createTestEmbedder({
        [reactMemory]: unitEmbedding(1),
        [mangoMemory]: unitEmbedding(2),
        "client rendering library": unitEmbedding(1),
      });
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
      });

      const react = await store.createMemory({
        content: reactMemory,
        kind: "preference",
        idempotencyKey: "memory-test:embedding-react",
      });
      nowMs += 1;
      await store.createMemory({
        content: mangoMemory,
        kind: "preference",
        idempotencyKey: "memory-test:embedding-mango",
      });

      const embeddingRows = await memoryDb(fixture)
        .select()
        .from(memorySqlSchema.juniorMemoryEmbeddings);
      expect(embeddingRows).toHaveLength(2);
      expect(embeddingRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dimensions: TEST_EMBEDDING_DIMENSIONS,
            memoryId: react.memory.id,
            metric: "cosine",
            model: "test-embedding-model",
            provider: "test-embedding-provider",
          }),
        ]),
      );
      const results = await store.searchMemories({
        query: "client rendering library",
      });
      expect(results[0]).toEqual(
        expect.objectContaining({ id: react.memory.id }),
      );
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("applies the vector cutoff to automatic recall without narrowing explicit search", async () => {
    const fixture = await createMemoryFixture();

    try {
      const query = "semantic needle";
      const closeContent = "Close vector-only memory.";
      const weakContent = "Weak vector-only memory.";
      const embedder = createTestEmbedder({
        [query]: unitEmbedding(0),
        [closeContent]: cosineEmbedding(0.8),
        [weakContent]: cosineEmbedding(0.5),
      });
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });
      const close = await store.createMemory({
        content: closeContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-distance-close",
      });
      const weak = await store.createMemory({
        content: weakContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-distance-weak",
      });

      await expect(store.recallMemories({ limit: 2, query })).resolves.toEqual([
        expect.objectContaining({ id: close.memory.id }),
      ]);
      await expect(store.searchMemories({ limit: 2, query })).resolves.toEqual([
        expect.objectContaining({ id: close.memory.id }),
        expect.objectContaining({ id: weak.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps lexical recall when an acceptable vector distractor exists", async () => {
    const fixture = await createMemoryFixture();

    try {
      const query = "America Los Angeles timezone";
      const vectorDistractor = "Prefers local times in calendar summaries.";
      const lexicalAnswer =
        "The user's timezone is America/Los_Angeles for Pacific time.";
      const embedder = createTestEmbedder({
        [query]: unitEmbedding(0),
        [vectorDistractor]: cosineEmbedding(0.8),
        [lexicalAnswer]: unitEmbedding(1),
      });
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });
      const distractor = await store.createMemory({
        content: vectorDistractor,
        kind: "preference",
        idempotencyKey: "memory-test:recall-vector-distractor",
      });
      const answer = await store.createMemory({
        content: lexicalAnswer,
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-lexical-answer",
      });

      // Hybrid recall must keep both legs. A close vector hit must not hide
      // the exact/token memory that only lexical retrieval surfaces.
      await expect(store.recallMemories({ limit: 2, query })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: distractor.memory.id }),
          expect.objectContaining({ id: answer.memory.id }),
        ]),
      );
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps an older private preference when public lexical noise fills the shared window", async () => {
    const fixture = await createMemoryFixture();

    try {
      // Mirrors production: "what time is it" only overlaps common tokens, so a
      // public lexical recency window can fill with newer shared knowledge
      // before ranking sees the older private preference.
      const query = "what time is it";
      const preferenceContent =
        "Located in San Francisco and uses Pacific Time (PT).";
      let nowMs = TEST_NOW_MS;
      const privateStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "D123" }),
        {
          // No embedder: force the pure lexical path that production noise hits.
          now: () => nowMs,
        },
      );
      const publicStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        // No embedder: force the pure lexical path that production noise hits.
        now: () => nowMs,
      });
      const preference = await privateStore.createMemory({
        content: preferenceContent,
        kind: "preference",
        idempotencyKey: "memory-test:recall-personal-timezone",
      });

      for (let index = 0; index < 80; index += 1) {
        nowMs = TEST_NOW_MS + index + 1;
        await publicStore.createConversationMemory({
          content: `Recent workspace time note ${index} about deploy time windows`,
          kind: "knowledge",
          idempotencyKey: `memory-test:recall-time-noise-${index}`,
        });
      }

      nowMs = TEST_NOW_MS + 200;
      // Public lexical recall alone would keep only the newest noise. The
      // private-scope probe must still surface the older domain preference.
      await expect(
        privateStore.recallMemories({ limit: 5, query }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: preference.memory.id,
            scope: "private",
          }),
        ]),
      );
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("fuses vector and lexical matches before applying the search limit", async () => {
    const fixture = await createMemoryFixture();

    try {
      const query = "exact lexical preference";
      const vectorMemories = [
        "Uses server components for dashboard filters.",
        "Keeps migrations generated through drizzle-kit.",
        "Maintains short-lived QA branches.",
        "Stores runbooks near deploy checklists.",
      ];
      const lexicalMemory = "Exact lexical preference lives in this memory.";
      const vectors: Record<string, number[]> = {
        [query]: unitEmbedding(1),
      };
      for (const memory of vectorMemories) {
        vectors[memory] = unitEmbedding(1);
      }
      const embedder = createTestEmbedder(vectors);
      let nowMs = TEST_NOW_MS;
      const vectorStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
      });
      for (const [index, memory] of vectorMemories.entries()) {
        nowMs += 1;
        await vectorStore.createMemory({
          content: memory,
          kind: "preference",
          idempotencyKey: `memory-test:fusion-vector-${index}`,
        });
      }
      nowMs += 1;
      const lexicalStore = createMemoryStore(
        memoryDb(fixture),
        slackContext(),
        {
          now: () => nowMs,
        },
      );
      const lexical = await lexicalStore.createMemory({
        content: lexicalMemory,
        kind: "preference",
        idempotencyKey: "memory-test:fusion-lexical",
      });

      await expect(
        vectorStore.searchMemories({ limit: 1, query }),
      ).resolves.toEqual([expect.objectContaining({ id: lexical.memory.id })]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("prefers same-channel memories for otherwise close public conversation matches", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS - 1;
      const sameChannelStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "C123" }),
        {
          now: () => nowMs,
        },
      );
      const sameChannel = await sameChannelStore.createConversationMemory({
        content: "Deploy checklist lives in the release runbook.",
        kind: "knowledge",
        idempotencyKey: "memory-test:source-boost-same",
      });

      nowMs = TEST_NOW_MS;
      const otherChannelStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "C456" }),
        {
          now: () => nowMs,
        },
      );
      const otherChannel = await otherChannelStore.createConversationMemory({
        content: "Deploy checklist lives in the release notes.",
        kind: "knowledge",
        idempotencyKey: "memory-test:source-boost-other",
      });

      await expect(
        sameChannelStore.searchMemories({
          limit: 2,
          query: "deploy checklist lives release",
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: sameChannel.memory.id }),
        expect.objectContaining({ id: otherChannel.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps stronger vector relevance ahead of same-channel proximity", async () => {
    const fixture = await createMemoryFixture();

    try {
      const query = "semantic channel relevance";
      const sameChannelContent = "Same channel semantic memory.";
      const otherChannelContent = "Other channel stronger semantic memory.";
      const embedder = createTestEmbedder({
        [query]: unitEmbedding(0),
        [sameChannelContent]: cosineEmbedding(0.9),
        [otherChannelContent]: cosineEmbedding(0.995),
      });
      let nowMs = TEST_NOW_MS;
      const sameChannelStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "C123" }),
        {
          embedder,
          now: () => nowMs,
        },
      );
      const sameChannel = await sameChannelStore.createConversationMemory({
        content: sameChannelContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:source-boost-vector-same",
      });

      nowMs += 1;
      const otherChannelStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "C456" }),
        {
          embedder,
          now: () => nowMs,
        },
      );
      const otherChannel = await otherChannelStore.createConversationMemory({
        content: otherChannelContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:source-boost-vector-other",
      });

      await expect(
        sameChannelStore.searchMemories({
          limit: 2,
          query,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: otherChannel.memory.id }),
        expect.objectContaining({ id: sameChannel.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("uses observed recency only as a relevance tie-breaker", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS - 120 * 24 * 60 * 60 * 1000;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });
      const oldRelevant = await store.createMemory({
        content:
          "Deploy checklist ownership escalation requires release approval.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recency-old-relevant",
      });
      nowMs = TEST_NOW_MS;
      const newLessRelevant = await store.createMemory({
        content: "Deploy snacks live near the office checklist.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recency-new-less-relevant",
      });

      await expect(
        store.searchMemories({
          limit: 2,
          query: "deploy checklist ownership escalation approval",
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: oldRelevant.memory.id }),
        expect.objectContaining({ id: newLessRelevant.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("prefers newer memories when search relevance is otherwise equal", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS - 120 * 24 * 60 * 60 * 1000;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });
      const oldMemory = await store.createMemory({
        content: "Deploy checklist lives in the legacy wiki.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recency-old-equal",
      });
      nowMs = TEST_NOW_MS;
      const newMemory = await store.createMemory({
        content: "Deploy checklist lives in Notion.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recency-new-equal",
      });

      await expect(
        store.searchMemories({ limit: 2, query: "deploy checklist" }),
      ).resolves.toEqual([
        expect.objectContaining({ id: newMemory.memory.id }),
        expect.objectContaining({ id: oldMemory.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps vector relevance ahead of observed recency outside near ties", async () => {
    const fixture = await createMemoryFixture();

    try {
      const query = "semantic needle";
      const oldContent = "Old vector-only memory.";
      const newContent = "New vector-only memory.";
      const embedder = createTestEmbedder({
        [query]: unitEmbedding(0),
        [oldContent]: cosineEmbedding(0.995),
        [newContent]: cosineEmbedding(0.9),
      });
      let nowMs = TEST_NOW_MS - 120 * 24 * 60 * 60 * 1000;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
      });
      const oldMemory = await store.createMemory({
        content: oldContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:recency-vector-old",
      });
      nowMs = TEST_NOW_MS;
      const newMemory = await store.createMemory({
        content: newContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:recency-vector-new",
      });

      await expect(store.searchMemories({ limit: 2, query })).resolves.toEqual([
        expect.objectContaining({ id: oldMemory.memory.id }),
        expect.objectContaining({ id: newMemory.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not duplicate embeddings for idempotent create retries", async () => {
    const fixture = await createMemoryFixture();

    try {
      const embedder = createTestEmbedder();
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });

      const created = await store.createMemory({
        content: "Prefers duplicate-safe vector writes.",
        kind: "preference",
        idempotencyKey: "memory-test:embedding-idempotent",
      });
      await expect(
        store.createMemory({
          content: "Changed retry content should not be re-embedded.",
          kind: "preference",
          idempotencyKey: "memory-test:embedding-idempotent",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id },
      });

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toHaveLength(1);
      expect(embedder.calls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("returns an existing same-kind memory for exact duplicate content", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });

      const created = await store.createMemory({
        content: "Prefers release notes with risk callouts.",
        kind: "preference",
        idempotencyKey: "memory-test:exact-dedup-original",
      });
      await expect(
        store.createMemory({
          content: "  Prefers release notes\nwith risk callouts.  ",
          kind: "preference",
          expiresAtMs: TEST_NOW_MS + 1,
          idempotencyKey: "memory-test:exact-dedup-repeat",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id },
      });
      nowMs = TEST_NOW_MS + 2;
      await expect(
        store.createMemory({
          content: "Changed retry content must not create a duplicate.",
          kind: "preference",
          idempotencyKey: "memory-test:exact-dedup-repeat",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id },
      });
      const otherKind = await store.createMemory({
        content: "Prefers release notes with risk callouts.",
        kind: "knowledge",
        idempotencyKey: "memory-test:exact-dedup-other-kind",
      });
      expect(otherKind).toMatchObject({
        created: true,
        memory: { content: created.memory.content, kind: "knowledge" },
      });
      const otherScope = await store.createConversationMemory({
        content: "Prefers release notes with risk callouts.",
        kind: "preference",
        idempotencyKey: "memory-test:exact-dedup-other-scope",
      });
      expect(otherScope).toMatchObject({
        created: true,
        memory: { content: created.memory.content, kind: "preference" },
      });

      await expect(store.listMemories({})).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: otherScope.memory.id }),
          expect.objectContaining({ id: otherKind.memory.id }),
          expect.objectContaining({ id: created.memory.id }),
        ]),
      );
      await expect(store.listMemories({})).resolves.toHaveLength(3);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("preserves retry identity for a distinct semantic neighbor", async () => {
    const fixture = await createMemoryFixture();

    try {
      const firstContent = "Prefers weekly summaries in bullet form.";
      const duplicateContent = "Likes weekly updates as bullet lists.";
      const embedder = createTestEmbedder({
        [firstContent]: unitEmbedding(1),
        [duplicateContent]: unitEmbedding(1),
      });
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });

      const first = await store.createMemory({
        content: firstContent,
        kind: "preference",
        idempotencyKey: "memory-test:vector-dedup-idempotent-original",
      });
      const second = await store.createMemory({
        content: duplicateContent,
        kind: "preference",
        idempotencyKey: "memory-test:vector-dedup-idempotent-repeat",
      });
      expect(second).toMatchObject({
        created: true,
        memory: { content: duplicateContent },
      });
      expect(second.memory.id).not.toBe(first.memory.id);
      await expect(
        store.createMemory({
          content:
            "Changed retry content should resolve to its original write.",
          kind: "preference",
          idempotencyKey: "memory-test:vector-dedup-idempotent-repeat",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: second.memory.id, content: duplicateContent },
      });

      await expect(store.listMemories({})).resolves.toHaveLength(2);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not collapse distinct facts with identical embeddings", async () => {
    const fixture = await createMemoryFixture();

    try {
      const firstContent = "getsentry/junior CI runs package tests with pnpm.";
      const duplicateContent =
        "getsentry/junior-old CI runs package tests with pnpm.";
      const embedder = createTestEmbedder({
        [firstContent]: unitEmbedding(1),
        [duplicateContent]: unitEmbedding(1),
      });
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });

      const created = await store.createMemory({
        content: firstContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:vector-dedup-original",
      });
      const neighbor = await store.createMemory({
        content: duplicateContent,
        kind: "knowledge",
        idempotencyKey: "memory-test:vector-dedup-repeat",
      });
      expect(neighbor).toMatchObject({
        created: true,
        memory: { content: duplicateContent },
      });
      expect(neighbor.memory.id).not.toBe(created.memory.id);

      await expect(store.listMemories({})).resolves.toHaveLength(2);
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toHaveLength(2);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("backfills missing embeddings on idempotent create retries", async () => {
    const fixture = await createMemoryFixture();

    try {
      const content = "Prefers derived embeddings to be repairable.";
      const firstStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });
      const created = await firstStore.createMemory({
        content,
        kind: "preference",
        idempotencyKey: "memory-test:embedding-retry-backfill",
      });
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([]);

      const embedder = createTestEmbedder();
      const retryStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS + 1,
      });
      await expect(
        retryStore.createMemory({
          content: "Changed retry content should not be embedded.",
          kind: "preference",
          idempotencyKey: "memory-test:embedding-retry-backfill",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id },
      });

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([
        expect.objectContaining({ memoryId: created.memory.id }),
      ]);
      expect(embedder.calls).toEqual([[content]]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("archives expired visible memories during reads", async () => {
    const fixture = await createMemoryFixture();

    try {
      const expiredContent = "Temporary CLI memory should expire cleanly.";
      const activeContent = "Persistent CLI memory should remain visible.";
      const supersededContent = "Superseded CLI memory stays superseded.";
      const embedder = createTestEmbedder({
        [expiredContent]: unitEmbedding(1),
        [activeContent]: unitEmbedding(2),
        [supersededContent]: unitEmbedding(3),
      });
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
      });

      const expired = await store.createMemory({
        content: expiredContent,
        kind: "preference",
        expiresAtMs: TEST_NOW_MS + 10,
        idempotencyKey: "memory-test:read-expired",
      });
      const active = await store.createMemory({
        content: activeContent,
        kind: "preference",
        idempotencyKey: "memory-test:read-active",
      });
      const superseded = await store.createMemory({
        content: supersededContent,
        kind: "preference",
        expiresAtMs: TEST_NOW_MS + 10,
        idempotencyKey: "memory-test:read-superseded",
      });
      await memoryDb(fixture)
        .update(memorySqlSchema.juniorMemoryMemories)
        .set({ supersededAtMs: TEST_NOW_MS + 1 })
        .where(
          eq(memorySqlSchema.juniorMemoryMemories.id, superseded.memory.id),
        );
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toHaveLength(3);

      nowMs = TEST_NOW_MS + 11;
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: active.memory.id }),
      ]);
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(memorySqlSchema.juniorMemoryMemories.id, expired.memory.id),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          archiveReason: "expired",
          archivedAtMs: TEST_NOW_MS + 11,
        }),
      ]);
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ memoryId: active.memory.id }),
          expect.objectContaining({ memoryId: superseded.memory.id }),
        ]),
      );
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toHaveLength(2);
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(memorySqlSchema.juniorMemoryMemories.id, superseded.memory.id),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          archivedAtMs: null,
          archiveReason: null,
          supersededAtMs: TEST_NOW_MS + 1,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps memories searchable when embeddings have the wrong dimension", async () => {
    const fixture = await createMemoryFixture();

    try {
      const embedder = createTestEmbedder(
        { "Prefers lexical fallback for vector failures.": [1, 0, 0] },
        { dimensions: 3 },
      );
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });

      const created = await store.createMemory({
        content: "Prefers lexical fallback for vector failures.",
        kind: "preference",
        idempotencyKey: "memory-test:embedding-dimension-mismatch",
      });

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([]);
      await expect(
        store.searchMemories({ query: "lexical fallback" }),
      ).resolves.toEqual([expect.objectContaining({ id: created.memory.id })]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("exposes context-bound memory management tools", async () => {
    const fixture = await createMemoryFixture();

    try {
      const reviewedRequests: CreateMemoryRequest[] = [];
      const context = {
        agent: allowMemory("actor", (request) => {
          reviewedRequests.push(request);
        }),
        db: memoryDb(fixture),
        ...slackContext({ channelId: "D123" }),
      };
      const tools = {
        createMemory: createMemoryCreateTool(context),
        removeMemory: createMemoryRemoveTool(context),
        listMemories: createMemoryListTool(context),
        searchMemories: createMemorySearchTool(context),
      };

      expect(tools.createMemory.approvalMode).toBe("approve");
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer terse status updates.",
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).resolves.toMatchObject({
        created: true,
        memory: {
          content: "Prefers terse status updates.",
        },
      });
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(
              memorySqlSchema.juniorMemoryMemories.content,
              "Prefers terse status updates.",
            ),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          scope: "private",
          kind: "preference",
        }),
      ]);
      expect(reviewedRequests[0]).toMatchObject({
        content: "I prefer terse status updates.",
        runtimeContext: {
          conversationId: "slack:D123:1718800000.000000",
          actor: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          },
          source: {
            platform: "slack",
            visibility: "private",
            teamId: "T123",
            channelId: "D123",
            messageTs: "1718800000.000000",
            threadTs: "1718800000.000000",
          },
        },
      });
      expect(reviewedRequests[0]).not.toHaveProperty("expiresAtMs");
      await expect(
        createMemoryCreateTool({
          ...context,
          agent: allowMemory("conversation"),
        }).execute(
          {
            content: "Incident notes live in Linear.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-conversation" },
        ),
      ).resolves.toMatchObject({
        created: true,
        memory: {
          content: "Incident notes live in Linear.",
        },
      });
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(
              memorySqlSchema.juniorMemoryMemories.content,
              "Incident notes live in Linear.",
            ),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          scope: "private",
          kind: "knowledge",
        }),
      ]);

      await expect(
        tools.listMemories.execute({ limit: 10 }, {}),
      ).resolves.toMatchObject({
        memories: [
          expect.objectContaining({
            content: "Incident notes live in Linear.",
          }),
          expect.objectContaining({
            content: "Prefers terse status updates.",
          }),
        ],
      });
      await expect(
        tools.searchMemories.execute({ query: "incident notes" }, {}),
      ).resolves.toMatchObject({
        memories: [
          expect.objectContaining({
            content: "Incident notes live in Linear.",
          }),
        ],
      });

      const listResult = (await tools.listMemories.execute(
        { limit: 10 },
        {},
      )) as {
        memories: Array<{ content: string; id: string }>;
      };
      const personal = listResult.memories.find(
        (memory) => memory.content === "Prefers terse status updates.",
      );
      expect(personal).toBeDefined();
      await expect(
        tools.removeMemory.execute({ id: personal!.id.slice(0, 12) }, {}),
      ).resolves.toMatchObject({
        memory: {
          id: personal!.id,
          content: "Prefers terse status updates.",
        },
      });
      await expect(
        tools.searchMemories.execute({ query: "terse status" }, {}),
      ).resolves.toMatchObject({ memories: [] });

      await expect(
        createMemoryCreateTool({
          ...context,
          agent: {
            reviewCreateRequest() {
              throw new Error(
                "Memory agent should not review missing tool ids.",
              );
            },
          },
        }).execute(
          {
            content: "I prefer missing retry ids to fail.",
            expires_at: "never",
          },
          {},
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer invalid expiration to fail.",
            expires_at: "not-a-date",
          },
          { toolCallId: "tool-create-invalid-expiration" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer valid expiration to be stored.",
            expires_at: "2026-06-19T13:00:00+00:00",
          },
          { toolCallId: "tool-create-valid-expiration" },
        ),
      ).resolves.toMatchObject({
        created: true,
        memory: {
          content: "Prefers valid expiration to be stored.",
          expiresAtMs: Date.parse("2026-06-19T13:00:00+00:00"),
        },
      });
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer hidden fields to fail.",
            expires_at: "never",
            scope: "public",
          } as never,
          { toolCallId: "tool-create-hidden-field" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
          {
            content: " \n\t ",
            expires_at: "never",
          },
          { toolCallId: "tool-create-empty-content" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        createMemoryCreateTool({
          agent: rejectMemory,
          db: memoryDb(fixture),
          ...slackContext(),
        }).execute(
          {
            content: "I prefer rejected memories not to be stored.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-rejected" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        createMemoryCreateTool({
          agent: allowMemory("actor"),
          db: memoryDb(fixture),
          source: slackContext().source,
        }).execute(
          {
            content: "I prefer actor context failures to be visible.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-missing-actor" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer duplicate-safe retries.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).resolves.toMatchObject({
        created: true,
        memory: { content: "Prefers duplicate-safe retries." },
      });
      await expect(
        tools.searchMemories.execute({ query: "duplicate-safe retries" }, {}),
      ).resolves.toMatchObject({
        memories: [
          expect.objectContaining({
            content: "Prefers duplicate-safe retries.",
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("retains user and conversation subjects as structured recall context", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const context = slackContext({ channelId: "D123" });
      const store = createMemoryStore(memoryDb(fixture), context, {
        now: () => nowMs,
      });
      const personal = await store.createMemory({
        content: "Prefers PR summaries with risks first.",
        kind: "preference",
        idempotencyKey: "memory-test:recall-personal",
      });
      nowMs += 1;
      const conversation = await store.createConversationMemory({
        content: "Release notes live in Notion.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-conversation",
      });
      nowMs += 1;
      await store.createMemory({
        content: "Prefers PR summary obsolete wording.",
        kind: "preference",
        expiresAtMs: TEST_NOW_MS + 1,
        idempotencyKey: "memory-test:recall-expired",
      });
      nowMs += 1;
      await createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "D456", userId: "U456" }),
        { now: () => nowMs },
      ).createMemory({
        content: "Prefers PR summary unrelated owner.",
        kind: "preference",
        idempotencyKey: "memory-test:recall-other-user",
      });

      const emitted: PluginConversationEventValue[] = [];
      const plugin = memoryPlugin();
      const result = await plugin.hooks?.userPrompt?.({
        ...context,
        destination: slackDestination(context),
        db: memoryDb(fixture),
        embedder: createTestEmbedder({}, { costUsd: 0.0003 }),
        events: {
          async emit(event) {
            emitted.push(event);
          },
        },
        log: noopLogger,
        model: recallModel((candidates) => candidates, 0.0042),
        plugin: { name: "memory" },
        state: memoryState,
        text: "Draft a PR summary and mention release notes.",
      });

      const contribution = result?.[0];
      expect(contribution && "context" in contribution).toBe(true);
      if (!contribution || !("context" in contribution)) {
        throw new Error("Memory recall did not return structured context");
      }
      expect(contribution.context).toEqual({
        kind: "recall",
        version: 1,
        content: {
          memories: [
            {
              id: conversation.memory.id,
              content: conversation.memory.content,
              kind: conversation.memory.kind,
              observedAtMs: conversation.memory.observedAtMs,
              scope: "private",
            },
            {
              id: personal.memory.id,
              content: personal.memory.content,
              kind: personal.memory.kind,
              observedAtMs: personal.memory.observedAtMs,
              scope: "private",
            },
          ],
        },
      });
      const text = contribution.renderPrompt();
      expect(text).toContain(`Observed 2026-06-19: ${personal.memory.content}`);
      expect(text).toContain(conversation.memory.content);
      expect(text).not.toContain(personal.memory.id);
      expect(text).not.toContain(conversation.memory.id);
      expect(text).not.toContain("obsolete wording");
      expect(text).not.toContain("unrelated owner");
      expect(emitted).toEqual([
        expect.objectContaining({
          data: {
            costUsd: 0.0045,
            memories: [conversation.memory.id, personal.memory.id],
          },
          definition: expect.objectContaining({
            eventName: "memories_recalled",
            version: 1,
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("admits more than five relevant memories when they fit the prompt budget", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const context = slackContext();
      const store = createMemoryStore(memoryDb(fixture), context, {
        now: () => nowMs,
      });
      const created = [];
      for (let index = 0; index < 6; index += 1) {
        created.push(
          await store.createConversationMemory({
            content: `Deploy step ${index + 1} uses checklist item ${index + 1}.`,
            kind: "procedure",
            idempotencyKey: `memory-test:recall-budget-${index}`,
          }),
        );
        nowMs += 1;
      }

      const emitted: PluginConversationEventValue[] = [];
      const plugin = memoryPlugin();
      const result = await plugin.hooks?.userPrompt?.({
        ...context,
        destination: slackDestination(context),
        db: memoryDb(fixture),
        embedder: createTestEmbedder(),
        events: {
          async emit(event) {
            emitted.push(event);
          },
        },
        log: noopLogger,
        model: selectAllRecallModel,
        plugin: { name: "memory" },
        state: memoryState,
        text: "Walk through the deploy checklist steps.",
      });

      const contribution = result?.[0];
      expect(contribution && "context" in contribution).toBe(true);
      if (!contribution || !("context" in contribution)) {
        throw new Error("Memory recall did not return structured context");
      }
      const admittedIds = contribution.context.content.memories.map(
        (memory) => memory.id,
      );
      expect(admittedIds).toHaveLength(6);
      expect([...admittedIds].sort()).toEqual(
        created.map(({ memory }) => memory.id).sort(),
      );
      expect(emitted).toEqual([
        expect.objectContaining({
          data: { memories: admittedIds },
          definition: expect.objectContaining({
            eventName: "memories_recalled",
            version: 1,
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("retains conversation memory recall as structured prompt context", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = slackContext();
      const conversation = await createMemoryStore(memoryDb(fixture), context, {
        now: () => TEST_NOW_MS,
      }).createConversationMemory({
        content: "Release notes live in Notion.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-conversation-context",
      });

      const plugin = memoryPlugin();
      const result = await plugin.hooks?.userPrompt?.({
        ...context,
        destination: slackDestination(context),
        db: memoryDb(fixture),
        embedder: createTestEmbedder(),
        log: noopLogger,
        model: selectAllRecallModel,
        plugin: { name: "memory" },
        state: memoryState,
        text: "Where do release notes live?",
      });

      const contribution = result?.[0];
      expect(contribution && "context" in contribution).toBe(true);
      if (!contribution || !("context" in contribution)) {
        throw new Error("Memory recall did not return structured context");
      }
      expect(contribution.context).toEqual({
        kind: "recall",
        version: 1,
        content: {
          memories: [
            {
              id: conversation.memory.id,
              content: conversation.memory.content,
              kind: conversation.memory.kind,
              observedAtMs: conversation.memory.observedAtMs,
              scope: "public",
            },
          ],
        },
      });
      expect(contribution.renderPrompt()).toBe(
        [
          "Relevant memories for this request:",
          "- Observed 2026-06-19: Release notes live in Notion.",
          "",
          "Treat these as possibly stale context. Current user instructions and repository evidence take priority.",
        ].join("\n"),
      );
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("filters candidates that only share repository and CI vocabulary", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = slackContext();
      const store = createMemoryStore(memoryDb(fixture), context, {
        now: () => TEST_NOW_MS,
      });
      const relevant = await store.createConversationMemory({
        content: "getsentry/junior CI runs package tests with pnpm.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-gate-relevant",
      });
      await store.createConversationMemory({
        content: "getsentry/sentry autofix PR tests use a dashboard workflow.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-gate-vocabulary",
      });
      await store.createConversationMemory({
        content:
          "Single-tenant repository access is configured in the admin dashboard.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-gate-unrelated",
      });

      const plugin = memoryPlugin();
      const result = await plugin.hooks?.userPrompt?.({
        ...context,
        destination: slackDestination(context),
        db: memoryDb(fixture),
        embedder: createTestEmbedder(),
        log: noopLogger,
        model: recallModel((candidates) =>
          candidates.filter((content) => content.includes("getsentry/junior")),
        ),
        plugin: { name: "memory" },
        state: memoryState,
        text: "How does CI work in getsentry/junior?",
      });

      const contribution = result?.[0];
      expect(contribution && "context" in contribution).toBe(true);
      if (!contribution || !("context" in contribution)) {
        throw new Error("Memory recall did not return structured context");
      }
      expect(contribution.context.content).toMatchObject({
        memories: [{ id: relevant.memory.id }],
      });
      expect(contribution.renderPrompt()).not.toContain("autofix");
      expect(contribution.renderPrompt()).not.toContain("Single-tenant");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("omits memory context when no candidate is directly relevant", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = slackContext();
      await createMemoryStore(memoryDb(fixture), context, {
        now: () => TEST_NOW_MS,
      }).createConversationMemory({
        content: "getsentry/sentry autofix PR tests use a dashboard workflow.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-gate-empty",
      });

      const emitted: PluginConversationEventValue[] = [];
      const plugin = memoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          destination: slackDestination(context),
          db: memoryDb(fixture),
          embedder: createTestEmbedder({}, { costUsd: 0.0002 }),
          events: {
            async emit(event) {
              emitted.push(event);
            },
          },
          log: noopLogger,
          model: recallModel(() => [], 0.0017),
          plugin: { name: "memory" },
          state: memoryState,
          text: "How do autofix PR tests use the dashboard workflow?",
        }),
      ).resolves.toBeUndefined();
      expect(emitted).toEqual([
        expect.objectContaining({
          data: { costUsd: 0.0019, memories: [] },
          definition: expect.objectContaining({
            eventName: "memories_recalled",
            version: 1,
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("records embedding cost when retrieval finds no recall candidates", async () => {
    const fixture = await createMemoryFixture();
    const emitted: PluginConversationEventValue[] = [];

    try {
      const context = slackContext();
      const plugin = memoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          destination: slackDestination(context),
          db: memoryDb(fixture),
          embedder: createTestEmbedder({}, { costUsd: 0.0002 }),
          events: {
            async emit(event) {
              emitted.push(event);
            },
          },
          log: noopLogger,
          model: {
            async completeObject() {
              throw new Error("Recall model should not run without candidates");
            },
          },
          plugin: { name: "memory" },
          state: memoryState,
          text: "Where do release notes live?",
        }),
      ).resolves.toBeUndefined();
      expect(emitted).toEqual([
        expect.objectContaining({
          data: { costUsd: 0.0002, memories: [] },
          definition: expect.objectContaining({
            eventName: "memories_recalled",
            version: 1,
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("continues without recalled context when relevance selection fails", async () => {
    const fixture = await createMemoryFixture();
    const warnings: string[] = [];
    const log: PluginLogger = {
      error() {},
      info() {},
      warn(message) {
        warnings.push(message);
      },
    };

    try {
      const context = slackContext();
      await createMemoryStore(memoryDb(fixture), context, {
        now: () => TEST_NOW_MS,
      }).createConversationMemory({
        content: "Release notes live in Notion.",
        kind: "knowledge",
        idempotencyKey: "memory-test:recall-gate-failure",
      });

      const plugin = memoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          destination: slackDestination(context),
          db: memoryDb(fixture),
          embedder: createTestEmbedder(),
          log,
          model: {
            async completeObject() {
              throw new Error("model unavailable");
            },
          },
          plugin: { name: "memory" },
          state: memoryState,
          text: "Where do release notes live?",
        }),
      ).resolves.toBeUndefined();
      expect(warnings).toEqual(["memory_recall_selection_failed"]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("skips user prompt memory recall when prompt text is blank", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = slackContext();
      await createMemoryStore(memoryDb(fixture), context).createMemory({
        content: "Prefers PR summaries with risks first.",
        kind: "preference",
        idempotencyKey: "memory-test:recall-blank",
      });

      const plugin = memoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          destination: slackDestination(context),
          db: memoryDb(fixture),
          embedder: createTestEmbedder(),
          log: noopLogger,
          model: selectAllRecallModel,
          plugin: { name: "memory" },
          state: memoryState,
          text: "   ",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("uses prompt hook embeddings for semantic recall", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = slackContext();
      const memory = "Uses React hooks for UI state.";
      const query = "client rendering library";
      const embedder = createTestEmbedder({
        [memory]: unitEmbedding(1),
        [query]: unitEmbedding(1),
      });
      await createMemoryStore(memoryDb(fixture), context, {
        embedder,
        now: () => TEST_NOW_MS,
      }).createMemory({
        content: memory,
        kind: "preference",
        idempotencyKey: "memory-test:recall-semantic",
      });

      const plugin = memoryPlugin();
      const result = await plugin.hooks?.userPrompt?.({
        ...context,
        destination: slackDestination(context),
        db: memoryDb(fixture),
        embedder,
        log: noopLogger,
        model: selectAllRecallModel,
        plugin: { name: "memory" },
        state: memoryState,
        text: query,
      });
      const contribution = result?.[0];
      expect(contribution && "context" in contribution).toBe(true);
      if (!contribution || !("context" in contribution)) {
        throw new Error("Memory recall did not return structured context");
      }
      expect(contribution.renderPrompt()).toContain(memory);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("scopes tool create idempotency to the runtime source", async () => {
    const fixture = await createMemoryFixture();

    try {
      const firstTool = createMemoryCreateTool({
        agent: allowMemory("actor"),
        db: memoryDb(fixture),
        ...slackContext(),
      });
      const secondTool = createMemoryCreateTool({
        agent: allowMemory("actor"),
        db: memoryDb(fixture),
        ...slackContext({ threadTs: "1718800001.000000" }),
      });

      await expect(
        firstTool.execute(
          {
            content: "I prefer the first remembered fact.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-reused-id" },
        ),
      ).resolves.toMatchObject({ created: true });
      await expect(
        secondTool.execute(
          {
            content: "I prefer the second remembered fact.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-reused-id" },
        ),
      ).resolves.toMatchObject({ created: true });

      await expect(
        createMemoryStore(memoryDb(fixture), slackContext()).listMemories({}),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Prefers the second remembered fact.",
        }),
        expect.objectContaining({
          content: "Prefers the first remembered fact.",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps local memory in its local conversation domain", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), localContext(), {
        now: () => nowMs,
      });

      const personal = await store.createMemory({
        content: "Prefers local CLI memory checks.",
        kind: "preference",
        idempotencyKey: "memory-test:local-personal",
      });
      nowMs = TEST_NOW_MS + 1;
      const conversation = await store.createConversationMemory({
        content: "Memory plugin validation is tracked in this local session.",
        kind: "knowledge",
        idempotencyKey: "memory-test:local-conversation",
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
        expect.objectContaining({ id: personal.memory.id }),
      ]);
      await expect(
        store.searchMemories({ query: "validation" }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);

      const otherConversationStore = createMemoryStore(
        memoryDb(fixture),
        localContext({ conversationId: "local:junior:other-memory-test" }),
        { now: () => nowMs },
      );
      await expect(otherConversationStore.listMemories({})).resolves.toEqual(
        [],
      );
      await expect(
        otherConversationStore.archiveMemory({ id: conversation.memory.id }),
      ).rejects.toThrow("Memory was not found in the current context.");

      nowMs = TEST_NOW_MS + 2;
      const archived = await store.archiveMemory({ id: personal.memory.id });
      expect(archived).toMatchObject({
        archivedAtMs: TEST_NOW_MS + 2,
        id: personal.memory.id,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("returns the original memory for idempotent create retries", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "D123" }),
        { now: () => nowMs },
      );

      const created = await store.createMemory({
        content: "Different content with the same retry key.",
        kind: "preference",
        idempotencyKey: "explicit-create-1",
      });
      expect(created.memory.observedAtMs).toBe(TEST_NOW_MS);

      nowMs = TEST_NOW_MS + 1;
      await expect(
        store.createMemory({
          content: "Changed content with the same retry key.",
          kind: "preference",
          idempotencyKey: "explicit-create-1",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id, content: created.memory.content },
      });
      await expect(
        fixture.execute(
          `
INSERT INTO junior_memory_memories (
  id,
  scope,
  scope_key,
  type,
  subject_type,
  subject_key,
  content,
  source_platform,
  source_key,
  idempotency_key,
  observed_at_ms,
  created_at_ms
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
)
`,
          [
            "mem_duplicate_idempotency",
            "private",
            "slack:T123:D123",
            "knowledge",
            "user",
            "slack:T123:U123",
            "Duplicate raw insert with same retry key.",
            "slack",
            "slack:T123:C123:1718800000.000000",
            "explicit-create-1",
            nowMs,
            nowMs,
          ],
        ),
      ).rejects.toThrow("duplicate key value violates unique constraint");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("reuses a semantic duplicate selected by preference adjudication without embeddings", async () => {
    const fixture = await createMemoryFixture();

    try {
      let duplicateId: string | undefined;
      const model: PluginModel = {
        async completeObject(input) {
          expect(input.prompt).toContain(
            "<memory-preference-adjudication-input>",
          );
          return {
            object: duplicateId
              ? { decision: "duplicate", duplicateId }
              : { decision: "distinct" },
          };
        },
      };
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
        supersessionDecider: createMemoryAgent(model),
      });
      const existing = await store.createMemory({
        content: "Prefers PR summaries with risks first.",
        kind: "preference",
        idempotencyKey: "memory-test:adjudicated-duplicate-original",
      });
      duplicateId = existing.memory.id;

      await expect(
        store.createMemory({
          content: "Wants danger notes at the beginning of code review recaps.",
          kind: "preference",
          idempotencyKey: "memory-test:adjudicated-duplicate-repeat",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: {
          content: existing.memory.content,
          id: existing.memory.id,
        },
      });
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: existing.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("uses recent preferences for adjudication without embeddings", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const existingContent =
        "Prefers deployment summaries to lead with risks.";
      const duplicateContent =
        "Wants concise release notes with warnings first.";
      const distractorContents = Array.from(
        { length: 12 },
        (_, index) => `Wants release notes for workflow detail ${index}.`,
      );
      let duplicateId: string | undefined;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
        supersessionDecider: {
          adjudicateSupersession(input) {
            if (input.candidate.content !== duplicateContent || !duplicateId) {
              return { decision: "distinct" };
            }
            return input.existingMemories.some(
              (memory) => memory.id === duplicateId,
            )
              ? { decision: "duplicate", duplicateId }
              : { decision: "distinct" };
          },
        },
      });
      for (const [index, content] of distractorContents.entries()) {
        nowMs = TEST_NOW_MS + index;
        await store.createMemory({
          content,
          kind: "preference",
          idempotencyKey: `memory-test:recent-candidate-distractor-${index}`,
        });
      }
      nowMs = TEST_NOW_MS + 20;
      const existing = await store.createMemory({
        content: existingContent,
        kind: "preference",
        idempotencyKey: "memory-test:recent-candidate-existing",
      });
      duplicateId = existing.memory.id;

      nowMs = TEST_NOW_MS + 21;
      await expect(
        store.createMemory({
          content: duplicateContent,
          kind: "preference",
          idempotencyKey: "memory-test:recent-candidate-duplicate",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: existing.memory.id },
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("supersedes old actor preferences when adjudication is confident", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const oldContent = "Prefers Python for automation scripts.";
      const newContent = "Prefers TypeScript for automation scripts.";
      const vectors: Record<string, number[]> = {
        [oldContent]: unitEmbedding(0),
        [newContent]: cosineEmbedding(0.98),
      };
      const unrelatedContents = Array.from(
        { length: 12 },
        (_, index) => `Prefers unrelated workflow detail ${index}.`,
      );
      for (const [index, content] of unrelatedContents.entries()) {
        vectors[content] = unitEmbedding(index + 2);
      }
      const embedder = createTestEmbedder(vectors);
      const preferenceAdjudicationCalls: MemorySupersessionInput[] = [];
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
        supersessionDecider: {
          adjudicateSupersession(input) {
            preferenceAdjudicationCalls.push(input);
            if (input.candidate.content !== newContent) {
              return { decision: "distinct" };
            }
            return {
              decision: "supersedes_old",
              supersededIds: [input.existingMemories[0].id],
            };
          },
        },
      });

      const oldMemory = await store.createMemory({
        content: oldContent,
        kind: "preference",
        idempotencyKey: "memory-test:supersession-old",
      });

      for (const [index, content] of unrelatedContents.entries()) {
        nowMs = TEST_NOW_MS + index + 1;
        await store.createMemory({
          content,
          kind: "preference",
          idempotencyKey: `memory-test:supersession-unrelated-${index}`,
        });
      }

      preferenceAdjudicationCalls.length = 0;
      nowMs = TEST_NOW_MS + 20;
      const newMemory = await store.createMemory({
        content: newContent,
        kind: "preference",
        idempotencyKey: "memory-test:supersession-new",
      });

      expect(preferenceAdjudicationCalls).toEqual([
        expect.objectContaining({
          candidate: { content: newContent, kind: "preference" },
          existingMemories: expect.arrayContaining([
            { content: oldContent, id: oldMemory.memory.id },
          ]),
        }),
      ]);
      expect(preferenceAdjudicationCalls[0]?.existingMemories[0]).toEqual({
        content: oldContent,
        id: oldMemory.memory.id,
      });
      const activeMemories = await store.listMemories({});
      expect(activeMemories).toContainEqual(
        expect.objectContaining({
          content: newContent,
          id: newMemory.memory.id,
        }),
      );
      expect(activeMemories).not.toContainEqual(
        expect.objectContaining({ id: oldMemory.memory.id }),
      );
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(memorySqlSchema.juniorMemoryMemories.id, oldMemory.memory.id),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          supersededAtMs: TEST_NOW_MS + 20,
          supersededById: newMemory.memory.id,
        }),
      ]);
      const embeddingRows = await memoryDb(fixture)
        .select()
        .from(memorySqlSchema.juniorMemoryEmbeddings);
      expect(embeddingRows).toContainEqual(
        expect.objectContaining({ memoryId: newMemory.memory.id }),
      );
      expect(embeddingRows).not.toContainEqual(
        expect.objectContaining({ memoryId: oldMemory.memory.id }),
      );

      nowMs = TEST_NOW_MS + 2;
      await expect(
        store.createMemory({
          content: "Different content with the superseding retry key.",
          kind: "preference",
          idempotencyKey: "memory-test:supersession-new",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: newMemory.memory.id },
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps old preferences active when supersession is not confident", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
        supersessionDecider: {
          adjudicateSupersession() {
            return { decision: "distinct" };
          },
        },
      });

      const oldMemory = await store.createMemory({
        content: "Prefers terse PR summaries.",
        kind: "preference",
        idempotencyKey: "memory-test:supersession-distinct-old",
      });

      nowMs = TEST_NOW_MS + 1;
      const newMemory = await store.createMemory({
        content: "Prefers Slack updates in the morning.",
        kind: "preference",
        idempotencyKey: "memory-test:supersession-distinct-new",
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: newMemory.memory.id }),
        expect.objectContaining({ id: oldMemory.memory.id }),
      ]);
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(memorySqlSchema.juniorMemoryMemories.id, oldMemory.memory.id),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          supersededAtMs: null,
          supersededById: null,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not supersede active preferences with immediately expired replacements", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const adjudicator: MemorySupersessionDecider = {
        adjudicateSupersession() {
          throw new Error("expired replacement should not use supersession");
        },
      };
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
        supersessionDecider: adjudicator,
      });

      const oldMemory = await store.createMemory({
        content: "Prefers Python for automation scripts.",
        kind: "preference",
        idempotencyKey: "memory-test:supersession-expired-old",
      });

      nowMs = TEST_NOW_MS + 1;
      await store.createMemory({
        content: "Prefers TypeScript for automation scripts.",
        expiresAtMs: TEST_NOW_MS,
        kind: "preference",
        idempotencyKey: "memory-test:supersession-expired-new",
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: oldMemory.memory.id }),
      ]);
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(memorySqlSchema.juniorMemoryMemories.id, oldMemory.memory.id),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          supersededAtMs: null,
          supersededById: null,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not supersede conversation-scoped preference rows", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
        supersessionDecider: {
          adjudicateSupersession() {
            throw new Error(
              "conversation-scoped preferences should not use supersession",
            );
          },
        },
      });

      const oldMemory = await store.createConversationMemory({
        content: "Prefers Python for automation scripts.",
        kind: "preference",
        idempotencyKey: "memory-test:supersession-conversation-old",
      });

      nowMs = TEST_NOW_MS + 1;
      const newMemory = await store.createConversationMemory({
        content: "Prefers TypeScript for automation scripts.",
        kind: "preference",
        idempotencyKey: "memory-test:supersession-conversation-new",
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: newMemory.memory.id }),
        expect.objectContaining({ id: oldMemory.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not adjudicate supersession for non-preference memories", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
        supersessionDecider: {
          adjudicateSupersession() {
            throw new Error("knowledge should not use preference supersession");
          },
        },
      });

      const oldMemory = await store.createMemory({
        content: "Deploy checks use the release runbook.",
        kind: "knowledge",
        idempotencyKey: "memory-test:supersession-knowledge-old",
      });

      nowMs = TEST_NOW_MS + 1;
      const newMemory = await store.createMemory({
        content: "Deploy checks use the release checklist.",
        kind: "knowledge",
        idempotencyKey: "memory-test:supersession-knowledge-new",
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: newMemory.memory.id }),
        expect.objectContaining({ id: oldMemory.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("recreates archived memories instead of resolving retries to hidden rows", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(
        memoryDb(fixture),
        slackContext({ channelId: "D123" }),
        { now: () => nowMs },
      );

      const archived = await store.createMemory({
        content: "Prefers short deployment summaries.",
        kind: "preference",
        idempotencyKey: "explicit-create-archived",
      });

      nowMs = TEST_NOW_MS + 1;
      await store.archiveMemory({ id: archived.memory.id });

      nowMs = TEST_NOW_MS + 2;
      const recreated = await store.createMemory({
        content: "Prefers short deployment summaries.",
        kind: "preference",
        idempotencyKey: "explicit-create-archived",
      });
      expect(recreated).toMatchObject({
        created: true,
        memory: { content: archived.memory.content },
      });
      expect(recreated.memory.id).not.toBe(archived.memory.id);

      nowMs = TEST_NOW_MS + 3;
      await expect(
        store.createMemory({
          content: "Changed content with the recreated retry key.",
          kind: "preference",
          idempotencyKey: "explicit-create-archived",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: {
          id: recreated.memory.id,
          content: recreated.memory.content,
        },
      });
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: recreated.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("treats expired memories as inactive for archive and recreate", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const content = "Temporarily prefers quiet deploy reminders.";
      const embedder = createTestEmbedder({ [content]: unitEmbedding(1) });
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
      });

      const expired = await store.createMemory({
        content,
        kind: "preference",
        expiresAtMs: TEST_NOW_MS + 10,
        idempotencyKey: "memory-test:expires",
      });

      nowMs = TEST_NOW_MS + 11;
      await expect(
        store.archiveMemory({ id: expired.memory.id }),
      ).rejects.toThrow("Memory was not found in the current context.");

      nowMs = TEST_NOW_MS + 12;
      const recreated = await store.createMemory({
        content,
        kind: "preference",
        idempotencyKey: "memory-test:expires",
      });

      expect(recreated).toMatchObject({
        created: true,
        memory: { content: expired.memory.content },
      });
      expect(recreated.memory.id).not.toBe(expired.memory.id);
      await expect(
        memoryDb(fixture)
          .select()
          .from(memorySqlSchema.juniorMemoryMemories)
          .where(
            eq(memorySqlSchema.juniorMemoryMemories.id, expired.memory.id),
          ),
      ).resolves.toEqual([
        expect.objectContaining({
          archiveReason: "expired",
          archivedAtMs: TEST_NOW_MS + 12,
        }),
      ]);
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([
        expect.objectContaining({ memoryId: recreated.memory.id }),
      ]);
      await expect(store.searchMemories({ query: "quiet" })).resolves.toEqual([
        expect.objectContaining({ id: recreated.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("searches active visible memories before applying the result limit", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });
      const target = await store.createConversationMemory({
        content: "Release cutover rehearsal is durable.",
        kind: "knowledge",
        idempotencyKey: "memory-test:search-target",
      });

      for (let index = 0; index < 205; index += 1) {
        nowMs = TEST_NOW_MS + index + 1;
        await store.createConversationMemory({
          content: `Recent unrelated memory ${index}`,
          kind: "knowledge",
          idempotencyKey: `memory-test:search-recent-${index}`,
        });
      }

      nowMs = TEST_NOW_MS + 300;
      await expect(
        store.searchMemories({ query: "cutover rehearsal" }),
      ).resolves.toEqual([expect.objectContaining({ id: target.memory.id })]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("fills the requested search limit from one healthy retrieval leg", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      // No embedder: vector leg stays empty so lexical alone must fill limit.
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });
      const ids: string[] = [];
      for (let index = 0; index < 55; index += 1) {
        nowMs = TEST_NOW_MS + index;
        const created = await store.createConversationMemory({
          content: `Deploy freeze checklist item ${index}`,
          kind: "knowledge",
          idempotencyKey: `memory-test:search-leg-fill-${index}`,
        });
        ids.push(created.memory.id);
      }

      const results = await store.searchMemories({
        limit: 50,
        query: "deploy freeze checklist",
      });
      expect(results).toHaveLength(50);
      expect(results.every((memory) => ids.includes(memory.id))).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("rejects hidden authority fields at the storage boundary", async () => {
    const fixture = await createMemoryFixture();

    try {
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });

      await expect(
        store.createMemory(
          ({
            content: "Prefers short PR summaries.",
            kind: "preference",
            idempotencyKey: "memory-test:smuggle",
            scope: "public",
            subjectKey: "slack:T123:U999",
            subjectType: "general",
          } as Parameters<typeof store.createMemory>[0]),
        ),
      ).rejects.toThrow(/Invalid input|Unrecognized key/);
      await expect(
        store.listMemories(
          ({
            actor: { platform: "local", userId: "local-user" },
          } as Parameters<typeof store.listMemories>[0]),
        ),
      ).rejects.toThrow(/Invalid input|Unrecognized key/);

      await expect(store.listMemories({})).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("rejects memory content that normalizes to empty text", async () => {
    const fixture = await createMemoryFixture();

    try {
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });

      await expect(
        store.createMemory({
          content: " \n\t ",
          kind: "preference",
          idempotencyKey: "memory-test:empty-content",
        }),
      ).rejects.toThrow("Memory content is required.");
      await expect(store.listMemories({})).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("rejects unsupported enum-like values at the storage boundary", async () => {
    const fixture = await createMemoryFixture();

    try {
      await expect(
        fixture.execute(
          `
INSERT INTO junior_memory_memories (
  id,
  scope,
  scope_key,
  type,
  subject_type,
  subject_key,
  content,
  source_platform,
  source_key,
  observed_at_ms,
  created_at_ms
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
)
`,
          [
            "mem_invalid_enum",
            "workspace",
            "slack:T123:U123",
            "knowledge",
            "general",
            null,
            "Unsupported scope value.",
            "slack",
            "slack:T123:C123:1718800000.000000",
            TEST_NOW_MS,
            TEST_NOW_MS,
          ],
        ),
      ).rejects.toThrow("violates check constraint");
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
