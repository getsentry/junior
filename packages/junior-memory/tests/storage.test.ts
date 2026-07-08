import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  pgliteVectorExtension,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import {
  createLocalSource,
  createSlackSource,
  PluginToolInputError,
  type PluginLogger,
  type PluginModel,
  type PluginRunTranscriptEntry,
  type PluginState,
  type PluginTaskContext,
  type Actor,
} from "@sentry/junior-plugin-api";
import { Command, CommanderError } from "commander";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as memorySqlSchema from "../src/db/schema";
import { createMemoryAgent, type CreateMemoryRequest } from "../src/agent";
import { createMemoryCliCommand } from "../src/cli";
import { createMemoryPlugin } from "../src/plugin";
import { processMemorySession } from "../src/process-session";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
  type MemoryReviewer,
} from "../src/tools";
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
    extensions: { vector: pgliteVectorExtension },
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
  overrides: { dimensions?: number; model?: string; provider?: string } = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    async embedTexts(input: { texts: string[] }) {
      calls.push(input.texts);
      return {
        dimensions: overrides.dimensions ?? TEST_EMBEDDING_DIMENSIONS,
        model: overrides.model ?? "test-embedding-model",
        provider: overrides.provider ?? "test-embedding-provider",
        vectors: input.texts.map((text) => vectors[text] ?? defaultEmbedding),
      };
    },
  };
}

function extractionModel(
  memories: Array<{
    content: string;
    expiresAtMs?: number | null;
    kind: "preference" | "procedure" | "knowledge";
    evidenceMessageIndices?: number[];
  }>,
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
    provenance: { authority: "context", ...(actor ? { actor } : {}) },
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
      type: channelId.startsWith("C") ? "pub" : "priv",
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
          : {}),
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

  it("registers explicit model id as memory plugin model configuration", () => {
    const plugin = createMemoryPlugin({
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
      const plugin = createMemoryPlugin();
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
        runtimeContext: localContext(),
      }),
    ).resolves.toEqual([
      {
        content: "Prefers causes before mitigations in incident writeups.",
        expiresAtMs: null,
        kind: "preference",
        evidenceMessageIndices: [0],
      },
    ]);
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

    await expect(
      agent.extractSessionMemories({
        transcript: [
          {
            type: "message",
            role: "user",
            text: "Store several durable facts.",
          },
        ],
        runtimeContext: localContext(),
      }),
    ).resolves.toHaveLength(5);
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
        runtimeContext: localContext(),
      }),
    ).rejects.toThrow("Too big");
  });

  it("uses AI_MEMORY_MODEL as the memory plugin model default", async () => {
    const previousModel = process.env.AI_MEMORY_MODEL;
    process.env.AI_MEMORY_MODEL = "anthropic/claude-sonnet-4.6";

    try {
      const plugin = createMemoryPlugin();
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
      const { model } = extractionModel([
        {
          kind: "preference",
          content: "Prefers QA notes that mention database row checks.",
        },
        {
          content: "Deploy runbooks live in Notion.",
          kind: "knowledge",
        },
      ]);
      const embedder = createTestEmbedder();

      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          embedder,
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
            scope: "personal",
            sourcePlatform: "local",
            subjectType: "user",
            kind: "preference",
          }),
          expect.objectContaining({
            content: "Deploy runbooks live in Notion.",
            scope: "conversation",
            sourcePlatform: "local",
            subjectType: "conversation",
            kind: "knowledge",
          }),
        ]),
      );
      expect(rows).toHaveLength(2);
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
            input.prompt.includes("<memory-supersession-input>")
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
            scope: "personal",
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
          scope: "conversation",
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
      const { model } = extractionModel([
        {
          content: "Prefers retry-safe memory extraction.",
          kind: "preference",
        },
      ]);
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
          model,
          run,
          state,
        }),
      );
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
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
          scope: "personal",
          kind: "preference",
        }),
      ]);
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
          scope: "conversation",
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

  it("skips passive extraction for failed memory mutation tool turns", async () => {
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
                    text: "Remember that I prefer failed mutation shielding.",
                  },
                  {
                    type: "toolResult",
                    toolName: "createMemory",
                    isError: true,
                    text: "Memory rejected.",
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

  it("skips passive extraction in private Slack contexts", async () => {
    const fixture = await createMemoryFixture();
    const privateContext = slackContext({ channelId: "D123" });

    try {
      await processMemorySession(
        processSessionContext({
          db: memoryDb(fixture),
          model: throwingExtractionModel,
          run: {
            async load() {
              return completedRun({
                conversationId: "slack:D123:1718800000.000000",
                destination: slackDestination(privateContext),
                transcript: [
                  {
                    type: "message",
                    role: "user",
                    text: "I prefer private Slack context skips.",
                  },
                ],
                actor: privateContext.actor,
                source: privateContext.source,
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

                  type: "priv",
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
          scope: "personal",
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
          scope: "conversation",
          subjectType: "conversation",
          kind: "procedure",
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
          scope: "personal",
          kind: "preference",
        }),
      ]);
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
          scope: "conversation",
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
          scope: "conversation",
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
      const actorContext = slackContext();
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), actorContext, {
        now: () => nowMs,
      });

      const personal = await store.createMemory({
        content: "Prefers short PR summaries.",
        kind: "preference",
        idempotencyKey: "memory-test:personal",
      });
      nowMs = TEST_NOW_MS + 1;
      const conversation = await store.createConversationMemory({
        content: "Deploy runbooks live in Notion.",
        kind: "knowledge",
        idempotencyKey: "memory-test:conversation",
      });

      expect(personal.created).toBe(true);
      expect(personal.memory).toMatchObject({ subjectType: "user" });
      expect(personal.memory).not.toHaveProperty("subjectKey");
      expect(conversation.created).toBe(true);
      expect(conversation.memory).toMatchObject({
        subjectType: "conversation",
      });
      expect(conversation.memory).not.toHaveProperty("subjectKey");
      await expect(
        fixture.query<{
          id: string;
          subject_key: string;
          subject_type: string;
        }>(
          `
SELECT id, subject_type, subject_key
FROM junior_memory_memories
ORDER BY created_at_ms ASC
`,
        ),
      ).resolves.toEqual([
        {
          id: personal.memory.id,
          subject_key: "slack:T123:U123",
          subject_type: "user",
        },
        {
          id: conversation.memory.id,
          subject_key: "slack:T123",
          subject_type: "conversation",
        },
      ]);

      nowMs = TEST_NOW_MS + 3;
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
        expect.objectContaining({ id: personal.memory.id }),
      ]);

      const otherActorStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(otherActorStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      const otherConversationStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({
          channelId: "C999",
          threadTs: "1718800001.000000",
          userId: "U456",
        }),
        { now: () => nowMs },
      );
      await expect(otherConversationStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);

      await expect(
        store.searchMemories({ query: "where are runbooks" }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      await expect(
        otherConversationStore.searchMemories({ query: "runbooks" }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      nowMs = TEST_NOW_MS + 4;
      const otherTeamStore = createMemoryStore(
        memoryDb(fixture),
        slackContext({ teamId: "T999", userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(otherTeamStore.listMemories({})).resolves.toEqual([]);
      await expect(
        otherTeamStore.archiveMemory({ id: conversation.memory.id }),
      ).rejects.toThrow("Memory was not found in the current context.");

      const archived = await store.archiveMemory({
        id: personal.memory.id.slice(0, 12),
      });
      expect(archived).toMatchObject({
        id: personal.memory.id,
        archivedAtMs: TEST_NOW_MS + 4,
      });
      nowMs = TEST_NOW_MS + 5;
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      await expect(
        store.searchMemories({ query: "summaries" }),
      ).resolves.toEqual([]);
    } finally {
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
        "personal",
        "--scope-key",
        "local:cli-user",
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
        "personal",
        "--scope-key",
        "local:cli-user",
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
        "personal",
        "--scope-key",
        "local:cli-user",
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
        "personal",
        "--scope-key",
        "local:cli-user",
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

  it("fuses vector and lexical matches before applying the search limit", async () => {
    const fixture = await createMemoryFixture();

    try {
      const query = "exact lexical preference";
      const vectorMemories = [
        "Uses server components for dashboard filters.",
        "Keeps migrations generated through drizzle-kit.",
        "Prefers short-lived QA branches.",
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

  it("preserves vector duplicate retry identity", async () => {
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

      const created = await store.createMemory({
        content: firstContent,
        kind: "preference",
        idempotencyKey: "memory-test:vector-dedup-idempotent-original",
      });
      await expect(
        store.createMemory({
          content: duplicateContent,
          kind: "preference",
          idempotencyKey: "memory-test:vector-dedup-idempotent-repeat",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id, content: firstContent },
      });
      await expect(
        store.createMemory({
          content: "Changed retry content should stay deduped.",
          kind: "preference",
          idempotencyKey: "memory-test:vector-dedup-idempotent-repeat",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id, content: firstContent },
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: created.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("returns an existing same-kind memory for high-confidence vector duplicates", async () => {
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

      const created = await store.createMemory({
        content: firstContent,
        kind: "preference",
        idempotencyKey: "memory-test:vector-dedup-original",
      });
      await expect(
        store.createMemory({
          content: duplicateContent,
          kind: "preference",
          idempotencyKey: "memory-test:vector-dedup-repeat",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id, content: firstContent },
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: created.memory.id }),
      ]);
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([
        expect.objectContaining({ memoryId: created.memory.id }),
      ]);
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
        ...slackContext(),
      };
      const tools = {
        createMemory: createMemoryCreateTool(context),
        removeMemory: createMemoryRemoveTool(context),
        listMemories: createMemoryListTool(context),
        searchMemories: createMemorySearchTool(context),
      };

      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer terse status updates.",
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).resolves.toMatchObject({
        ok: true,
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
          scope: "personal",
          kind: "preference",
        }),
      ]);
      expect(reviewedRequests[0]).toMatchObject({
        content: "I prefer terse status updates.",
        runtimeContext: {
          conversationId: "slack:C123:1718800000.000000",
          actor: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          },
          source: {
            platform: "slack",
            type: "pub",
            teamId: "T123",
            channelId: "C123",
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
        ok: true,
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
          scope: "conversation",
          kind: "knowledge",
        }),
      ]);

      await expect(
        tools.listMemories.execute({ limit: 10 }, {}),
      ).resolves.toMatchObject({
        ok: true,
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
        ok: true,
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
        ok: true,
        memory: {
          id: personal!.id,
          content: "Prefers terse status updates.",
        },
      });
      await expect(
        tools.searchMemories.execute({ query: "terse status" }, {}),
      ).resolves.toMatchObject({ ok: true, memories: [] });

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
        ok: true,
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
            scope: "conversation",
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
        ok: true,
        created: true,
        memory: { content: "Prefers duplicate-safe retries." },
      });
      await expect(
        tools.searchMemories.execute({ query: "duplicate-safe retries" }, {}),
      ).resolves.toMatchObject({
        ok: true,
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

  it("injects visible active memories into user prompt context", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const context = slackContext();
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
        slackContext({ userId: "U456" }),
        { now: () => nowMs },
      ).createMemory({
        content: "Prefers PR summary unrelated owner.",
        kind: "preference",
        idempotencyKey: "memory-test:recall-other-user",
      });

      const plugin = createMemoryPlugin();
      const result = await plugin.hooks?.userPrompt?.({
        ...context,
        destination: slackDestination(context),
        db: memoryDb(fixture),
        embedder: createTestEmbedder(),
        log: noopLogger,
        plugin: { name: "memory" },
        state: memoryState,
        text: "Draft a PR summary and mention release notes.",
      });

      expect(result).toEqual([
        {
          text: expect.stringContaining(personal.memory.content),
        },
      ]);
      const text = result?.[0]?.text ?? "";
      expect(text).toContain(`Observed 2026-06-19: ${personal.memory.content}`);
      expect(text).toContain(conversation.memory.content);
      expect(text).not.toContain(personal.memory.id);
      expect(text).not.toContain(conversation.memory.id);
      expect(text).not.toContain("obsolete wording");
      expect(text).not.toContain("unrelated owner");
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

      const plugin = createMemoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          destination: slackDestination(context),
          db: memoryDb(fixture),
          embedder: createTestEmbedder(),
          log: noopLogger,
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

      const plugin = createMemoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          destination: slackDestination(context),
          db: memoryDb(fixture),
          embedder,
          log: noopLogger,
          plugin: { name: "memory" },
          state: memoryState,
          text: query,
        }),
      ).resolves.toEqual([
        {
          text: expect.stringContaining(memory),
        },
      ]);
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

  it("stores and filters local conversation memories by local context", async () => {
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
      await expect(otherConversationStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: personal.memory.id }),
      ]);
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
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });

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
            "personal",
            "slack:T123:U123",
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

  it("supersedes old actor preferences when adjudication is confident", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const oldContent = "Prefers Python for automation scripts.";
      const newContent = "Prefers TypeScript for automation scripts.";
      const embedder = createTestEmbedder({
        [oldContent]: unitEmbedding(1),
        [newContent]: unitEmbedding(2),
      });
      const supersessionCalls: MemorySupersessionInput[] = [];
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
        supersessionDecider: {
          adjudicateSupersession(input) {
            supersessionCalls.push(input);
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

      for (let index = 0; index < 12; index += 1) {
        nowMs = TEST_NOW_MS + index + 1;
        await store.createMemory({
          content: `Prefers unrelated workflow detail ${index}.`,
          kind: "preference",
          idempotencyKey: `memory-test:supersession-unrelated-${index}`,
        });
      }

      supersessionCalls.length = 0;
      nowMs = TEST_NOW_MS + 20;
      const newMemory = await store.createMemory({
        content: newContent,
        kind: "preference",
        idempotencyKey: "memory-test:supersession-new",
      });

      expect(supersessionCalls).toEqual([
        expect.objectContaining({
          candidate: { content: newContent, kind: "preference" },
          existingMemories: expect.arrayContaining([
            { content: oldContent, id: oldMemory.memory.id },
          ]),
        }),
      ]);
      expect(supersessionCalls[0]?.existingMemories[0]).toEqual({
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
      const decider: MemorySupersessionDecider = {
        adjudicateSupersession() {
          throw new Error("expired replacement should not use supersession");
        },
      };
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
        supersessionDecider: decider,
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
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });

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

  it("rejects hidden authority fields at the storage boundary", async () => {
    const fixture = await createMemoryFixture();

    try {
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });

      await expect(
        store.createMemory({
          content: "Prefers short PR summaries.",
          kind: "preference",
          idempotencyKey: "memory-test:smuggle",
          scope: "conversation",
          subjectKey: "slack:T123:U999",
          subjectType: "general",
        } as unknown as Parameters<typeof store.createMemory>[0]),
      ).rejects.toThrow(/Invalid input|Unrecognized key/);
      await expect(
        store.listMemories({
          actor: { platform: "local", userId: "local-user" },
        } as unknown as Parameters<typeof store.listMemories>[0]),
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
