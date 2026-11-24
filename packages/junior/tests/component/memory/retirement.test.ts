import { strictProviderSchemaProblems } from "@sentry/junior-testing/structured-output";
import {
  createSlackSource,
  type Actor,
  type PluginConversationEventValue,
  type PluginModel,
  type PluginRunContext,
  type PluginRunTranscriptEntry,
  type PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as memorySqlSchema from "@/db/schema/memory";
import { processMemorySession } from "@/chat/memory/process-session";
import { createMemoryStore, type MemoryDb } from "@/chat/memory/store";
import { createMemoryFixture, type MemoryFixture } from "./fixture";

const TEST_NOW_MS = Date.parse("2026-06-19T12:00:00.000Z");
const DIMENSIONS = 1536;
const actor: Actor = { platform: "slack", teamId: "T123", userId: "U123" };

type ExtractionResponse = {
  contradictedMemories: Array<{
    evidenceMessageIndices: number[];
    memoryRef: string;
    replacementIndex: number | null;
  }>;
  memories: Array<{
    canonicalFact: string;
    evidenceMessageIndices: number[];
    expiresAtMs: null;
    kind: "knowledge" | "preference" | "procedure";
    statesChange: boolean;
  }>;
};

type AdjudicationResponse = {
  decision: "duplicate" | "supersedes_old" | "distinct" | "uncertain";
  duplicateId: string | null;
  supersededIds: string[] | null;
};

function slackRuntime(threadTs: string, userId = "U123") {
  return {
    conversationId: `slack:C123:${threadTs}`,
    locationId: "location:T123:C123",
    actor: { platform: "slack" as const, teamId: "T123", userId },
    source: createSlackSource({
      channelId: "C123",
      messageTs: threadTs,
      teamId: "T123",
      threadTs,
      visibility: "public",
    }),
    userId: `user:T123:${userId}`,
  };
}

function unitEmbedding(index: number): number[] {
  const embedding = Array.from({ length: DIMENSIONS }, () => 0);
  embedding[index] = 1;
  return embedding;
}

function cosineEmbedding(cosine: number): number[] {
  const embedding = Array.from({ length: DIMENSIONS }, () => 0);
  embedding[0] = cosine;
  embedding[1] = Math.sqrt(1 - cosine * cosine);
  return embedding;
}

/** Fake embedder: listed texts get their vector, others an unrelated one. */
function testEmbedder(vectors: Record<string, number[]>) {
  return {
    model: "test-embedding-model",
    provider: "test-embedding-provider",
    async embedTexts(input: { texts: string[] }) {
      return {
        dimensions: DIMENSIONS,
        model: "test-embedding-model",
        provider: "test-embedding-provider",
        vectors: input.texts.map((text) => vectors[text] ?? unitEmbedding(9)),
      };
    },
  };
}

/** Fake memory model: one extraction response and one adjudication response. */
function memoryModel(
  extraction: ExtractionResponse,
  adjudication: AdjudicationResponse = {
    decision: "distinct",
    duplicateId: null,
    supersededIds: null,
  },
) {
  const extractionCalls: Parameters<PluginModel["completeObject"]>[0][] = [];
  const adjudicationCalls: Parameters<PluginModel["completeObject"]>[0][] = [];
  const model: PluginModel = {
    async completeObject(input) {
      if (String(input.prompt).includes("<memory-adjudication-input>")) {
        adjudicationCalls.push(input);
        return { object: input.schema.parse(adjudication) };
      }
      extractionCalls.push(input);
      return { object: input.schema.parse(extraction) };
    },
  };
  return { adjudicationCalls, extractionCalls, model };
}

function userMessage(
  text: string,
  options: { isRunActor?: boolean; author?: Actor } = {},
): PluginRunTranscriptEntry {
  const isRunActor = options.isRunActor ?? true;
  return {
    type: "message",
    role: "user",
    text,
    provenance: { authority: "instruction", actor: options.author ?? actor },
    isRunActor,
  };
}

function toolResult(text: string): PluginRunTranscriptEntry {
  return { type: "toolResult", toolName: "readFile", isError: false, text };
}

function assistantMessage(text: string): PluginRunTranscriptEntry {
  return { type: "message", role: "assistant", text };
}

function taskContext(args: {
  db: MemoryDb;
  embedder: ReturnType<typeof testEmbedder>;
  emitted: PluginConversationEventValue[];
  model: PluginModel;
  recalledIds?: string[];
  threadTs?: string;
  transcript: PluginRunTranscriptEntry[];
}): PluginTaskContext {
  const runtime = slackRuntime(args.threadTs ?? "1718800099.000000");
  const run: PluginRunContext = {
    actor,
    actorUserId: runtime.userId,
    actors: [actor],
    completedAtMs: TEST_NOW_MS,
    conversationId: runtime.conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "C123" },
    runId: "slack-turn-retire",
    source: runtime.source,
    transcript: args.transcript,
  };
  const values = new Map<string, unknown>();
  return {
    cache: {
      async get() {
        return undefined;
      },
      async getOrLoad(_key, load) {
        return (await load()).value;
      },
      async update() {},
      async delete() {},
    },
    db: args.db,
    embedder: args.embedder,
    events: {
      async emit(event) {
        args.emitted.push(event);
      },
    },
    id: "plugin-task-retire",
    log: { error() {}, info() {}, warn() {} },
    model: args.model,
    name: "processSession",
    plugin: { name: "memory" },
    run: {
      async load() {
        return run;
      },
    },
    state: {
      async delete(key) {
        values.delete(key);
      },
      async get<T = unknown>(key: string) {
        return values.get(key) as T | undefined;
      },
      async set(key, value) {
        values.set(key, value);
      },
      async setIfNotExists() {
        return true;
      },
      async withLock(_key, _ttlMs, callback) {
        return { acquired: true, value: await callback() };
      },
    },
    turnEvents: {
      async list({ eventName }) {
        if (eventName !== "memories_recalled" || !args.recalledIds) return [];
        return [
          {
            content: { memories: args.recalledIds },
            createdAt: new Date(TEST_NOW_MS).toISOString(),
            seq: 1,
            turnId: run.runId,
            version: 1,
          },
        ];
      },
    },
  };
}

async function storeKnowledge(
  fixture: MemoryFixture,
  content: string,
  options: {
    embedder?: ReturnType<typeof testEmbedder>;
    kind?: "knowledge" | "preference";
    threadTs?: string;
    userId?: string;
  } = {},
) {
  const store = createMemoryStore(
    fixture.db(),
    slackRuntime(options.threadTs ?? "1718800001.000000", options.userId),
    { embedder: options.embedder, now: () => TEST_NOW_MS - 60_000 },
  );
  const input = {
    content,
    idempotencyKey: `test:${content}`,
    kind: options.kind ?? "knowledge",
  } as const;
  const result =
    input.kind === "preference"
      ? await store.createMemory(input)
      : await store.createConversationMemory(input);
  return result.memory;
}

async function memoryRow(fixture: MemoryFixture, id: string) {
  const [row] = await fixture
    .db()
    .select()
    .from(memorySqlSchema.juniorMemoryMemories)
    .where(eq(memorySqlSchema.juniorMemoryMemories.id, id));
  return row;
}

async function vectorCount(fixture: MemoryFixture, id: string) {
  const rows = await fixture
    .db()
    .select()
    .from(memorySqlSchema.juniorMemoryEmbeddings)
    .where(eq(memorySqlSchema.juniorMemoryEmbeddings.memoryId, id));
  return rows.length;
}

async function signalRows(fixture: MemoryFixture, id: string) {
  return await fixture
    .db()
    .select()
    .from(memorySqlSchema.juniorMemorySignals)
    .where(eq(memorySqlSchema.juniorMemorySignals.memoryId, id));
}

describe("automatic memory retirement", () => {
  it("archives a recalled memory that the Turn's tool result contradicts", async () => {
    const fixture = await createMemoryFixture();
    try {
      const embedder = testEmbedder({});
      const old = await storeKnowledge(
        fixture,
        "Junior skips OpenTelemetry setup with skipOpenTelemetrySetup.",
        { embedder },
      );
      const emitted: PluginConversationEventValue[] = [];
      const { extractionCalls, model } = memoryModel({
        contradictedMemories: [
          { evidenceMessageIndices: [1], memoryRef: "m1", replacementIndex: 0 },
        ],
        memories: [
          {
            canonicalFact:
              "Junior controls OpenTelemetry setup with enableOpenTelemetrySetup.",
            evidenceMessageIndices: [1],
            expiresAtMs: null,
            kind: "knowledge",
            statesChange: true,
          },
        ],
      });

      await processMemorySession(
        taskContext({
          db: fixture.db(),
          embedder,
          emitted,
          model,
          recalledIds: [old.id],
          transcript: [
            userMessage("How do I turn off OTel setup in Junior?"),
            toolResult(
              "export interface JuniorOptions { enableOpenTelemetrySetup?: boolean }",
            ),
            assistantMessage("Set enableOpenTelemetrySetup to false."),
          ],
        }),
      );

      expect(strictProviderSchemaProblems(extractionCalls[0]!.schema)).toEqual(
        [],
      );
      expect(String(extractionCalls[0]!.prompt)).toContain(
        "skipOpenTelemetrySetup",
      );
      const replacement = (
        emitted[0]!.data as { memories: Array<{ id: string }> }
      ).memories[0]!;
      expect(await memoryRow(fixture, old.id)).toMatchObject({
        archiveReason: "contradicted",
        archivedAtMs: expect.any(Number),
        supersededAtMs: null,
        supersededById: replacement.id,
      });
      expect(await vectorCount(fixture, old.id)).toBe(0);
      expect(await signalRows(fixture, old.id)).toEqual([
        expect.objectContaining({
          conversationId: "slack:C123:1718800099.000000",
          idempotencyKey: expect.stringMatching(/^session:/),
          signal: "contradicted",
        }),
      ]);
      // A retry of the write that made the old memory does not bring it back.
      const retry = await createMemoryStore(
        fixture.db(),
        slackRuntime("1718800001.000000"),
        { embedder, now: () => TEST_NOW_MS },
      ).createConversationMemory({
        content:
          "Junior skips OpenTelemetry setup with skipOpenTelemetrySetup.",
        idempotencyKey:
          "test:Junior skips OpenTelemetry setup with skipOpenTelemetrySetup.",
        kind: "knowledge",
      });
      expect(retry).toMatchObject({ created: false, memory: { id: old.id } });
      expect(await memoryRow(fixture, old.id)).toMatchObject({
        archiveReason: "contradicted",
      });
      expect(emitted[0]!.data).toEqual({
        archived: [
          expect.objectContaining({
            content:
              "Junior skips OpenTelemetry setup with skipOpenTelemetrySetup.",
            id: old.id,
            reason: "contradicted",
            supersededById: replacement.id,
          }),
        ],
        memories: [
          expect.objectContaining({
            content:
              "Junior controls OpenTelemetry setup with enableOpenTelemetrySetup.",
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps a recalled memory when the cited evidence cannot retire it", async () => {
    const fixture = await createMemoryFixture();
    try {
      const embedder = testEmbedder({});
      const knowledge = await storeKnowledge(
        fixture,
        "updatePlan does not persist plan steps.",
        { embedder },
      );
      const otherUsersPreference = await storeKnowledge(
        fixture,
        "Prefers terse PR summaries.",
        { embedder, kind: "preference", userId: "U456" },
      );
      const emitted: PluginConversationEventValue[] = [];
      const { model } = memoryModel({
        contradictedMemories: [
          // Assistant text is not evidence.
          {
            evidenceMessageIndices: [1],
            memoryRef: "m1",
            replacementIndex: null,
          },
          // The run actor cannot retire another User's preference.
          {
            evidenceMessageIndices: [0],
            memoryRef: "m2",
            replacementIndex: null,
          },
        ],
        memories: [],
      });

      await processMemorySession(
        taskContext({
          db: fixture.db(),
          embedder,
          emitted,
          model,
          recalledIds: [knowledge.id, otherUsersPreference.id],
          transcript: [
            userMessage("I prefer long PR summaries. Does updatePlan persist?"),
            assistantMessage("The plan is durable now."),
          ],
        }),
      );

      for (const id of [knowledge.id, otherUsersPreference.id]) {
        expect(await memoryRow(fixture, id)).toMatchObject({
          archivedAtMs: null,
          archiveReason: null,
        });
      }
      expect(emitted[0]!.data).toMatchObject({ archived: [] });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("replaces a fact from another Conversation only when the Turn says it changed", async () => {
    const fixture = await createMemoryFixture();
    try {
      const oldContent =
        "Memory recall probes use personal-scope memories only.";
      const newContent = "Memory recall probes use public memories only.";
      const embedder = testEmbedder({
        [oldContent]: unitEmbedding(0),
        [newContent]: cosineEmbedding(0.9),
      });
      const old = await storeKnowledge(fixture, oldContent, {
        embedder,
        threadTs: "1718800002.000000",
      });
      const extraction = (statesChange: boolean): ExtractionResponse => ({
        contradictedMemories: [],
        memories: [
          {
            canonicalFact: newContent,
            evidenceMessageIndices: [0],
            expiresAtMs: null,
            kind: "knowledge",
            statesChange,
          },
        ],
      });
      const supersede: AdjudicationResponse = {
        decision: "supersedes_old",
        duplicateId: null,
        supersededIds: [old.id],
      };

      // A plain statement of the current fact does not look across
      // Conversations, so the old memory stays.
      const plain = memoryModel(extraction(false), supersede);
      await processMemorySession(
        taskContext({
          db: fixture.db(),
          embedder,
          emitted: [],
          model: plain.model,
          transcript: [
            userMessage("Memory recall probes use public memories only."),
          ],
        }),
      );
      expect(plain.adjudicationCalls).toHaveLength(0);
      expect(await memoryRow(fixture, old.id)).toMatchObject({
        archivedAtMs: null,
      });

      const emitted: PluginConversationEventValue[] = [];
      const changed = memoryModel(extraction(true), supersede);
      const context = taskContext({
        db: fixture.db(),
        embedder,
        emitted,
        model: changed.model,
        threadTs: "1718800100.000000",
        transcript: [
          userMessage(
            "Memory recall probes no longer use personal-scope memories; they use public memories only.",
          ),
        ],
      });
      await processMemorySession(context);

      expect(changed.adjudicationCalls).toHaveLength(1);
      expect(String(changed.adjudicationCalls[0]!.prompt)).toContain(old.id);
      const archived = await memoryRow(fixture, old.id);
      expect(archived).toMatchObject({
        archiveReason: "superseded",
        archivedAtMs: expect.any(Number),
        supersededAtMs: null,
        supersededById: expect.any(String),
      });
      expect(await signalRows(fixture, old.id)).toEqual([
        expect.objectContaining({
          conversationId: "slack:C123:1718800100.000000",
          signal: "superseded",
        }),
      ]);
      expect(emitted[0]!.data).toMatchObject({
        archived: [
          expect.objectContaining({ id: old.id, reason: "superseded" }),
        ],
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
