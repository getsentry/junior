import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  pgliteBtreeGinExtension,
  pgliteVectorExtension,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import * as memorySqlSchema from "../src/db/schema";
import type { MemoryEmbeddingProvider } from "../src/embeddings";
import type { MemoryDb } from "../src/memories";
import {
  createConversationMemory,
  memoryFixture,
  searchMemories,
} from "./memory-operations";

const EMBEDDING_DIMENSIONS = 1536;
const NOW_MS = Date.parse("2026-07-29T12:00:00.000Z");
const __dirname = dirname(fileURLToPath(import.meta.url));

type MemoryFixture = LocalPgliteFixture<MemoryDb>;

function unitEmbedding(index: number): number[] {
  const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  embedding[index] = 1;
  return embedding;
}

function testEmbedder(
  vectors: Record<string, number[]>,
): MemoryEmbeddingProvider {
  return {
    async embedTexts({ texts }) {
      return {
        dimensions: EMBEDDING_DIMENSIONS,
        model: "retrieval-quality-model",
        provider: "retrieval-quality-provider",
        vectors: texts.map((text) => vectors[text] ?? unitEmbedding(10)),
      };
    },
  };
}

async function createFixture(): Promise<MemoryFixture> {
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
  for (const filename of migrations) {
    await fixture.execute(
      await readFile(resolve(migrationsDir, filename), "utf8"),
    );
  }
  return fixture;
}

function runtimeContext() {
  const teamId = "TQUALITY";
  const channelId = "CQUALITY";
  const threadTs = "1785326400.000000";
  return {
    actor: {
      platform: "slack" as const,
      teamId,
      userId: "UQUALITY",
    },
    conversationId: `slack:${channelId}:${threadTs}`,
    source: createSlackSource({
      channelId,
      messageTs: threadTs,
      teamId,
      threadTs,
      visibility: "public",
    }),
  };
}

describe("memory retrieval quality", () => {
  it("keeps lexical and semantic facts ahead of plausible distractors", async () => {
    const fixture = await createFixture();
    const targetedContent = "getsentry/junior CI runs package tests with pnpm.";
    const genericContent =
      "Repository CI guidance is available in the engineering dashboard.";
    const runbookContent = "Release runbooks are documented in Notion.";
    const semanticContent =
      "Deployments require canary verification before production rollout.";
    const targetedQuery = "Which CI setup runs package tests with pnpm?";
    const lexicalQuery = "Where are release runbooks documented?";
    const semanticQuery = "What is the publishing process?";
    const embedder = testEmbedder({
      [targetedContent]: unitEmbedding(0),
      [genericContent]: unitEmbedding(0),
      [runbookContent]: unitEmbedding(1),
      [semanticContent]: unitEmbedding(2),
      [targetedQuery]: unitEmbedding(0),
      [lexicalQuery]: unitEmbedding(1),
      [semanticQuery]: unitEmbedding(2),
    });
    const test = memoryFixture(fixture.db(), runtimeContext(), {
      embedder,
      now: () => NOW_MS,
    });

    try {
      const memories = new Map<string, string>();
      for (const [key, content] of [
        ["targeted", targetedContent],
        ["generic", genericContent],
        ["lexical", runbookContent],
        ["semantic", semanticContent],
      ] as const) {
        const result = await createConversationMemory(test, {
          content,
          idempotencyKey: `retrieval-quality:${key}`,
          kind: "knowledge",
        });
        memories.set(key, result.memory.id);
      }

      const cases = [
        { expected: memories.get("targeted"), query: targetedQuery },
        { expected: memories.get("lexical"), query: lexicalQuery },
        { expected: memories.get("semantic"), query: semanticQuery },
      ];
      const outcomes = await Promise.all(
        cases.map(async ({ expected, query }) => {
          const ranked = await searchMemories(test, { limit: 5, query });
          const rank = ranked.findIndex((memory) => memory.id === expected) + 1;
          return {
            hitAt1: rank === 1,
            reciprocalRank: rank > 0 ? 1 / rank : 0,
            recallAt5: rank > 0,
          };
        }),
      );
      const count = outcomes.length;
      const report = {
        hitAt1:
          outcomes.filter(({ hitAt1 }) => hitAt1).length / Math.max(1, count),
        meanReciprocalRank:
          outcomes.reduce(
            (total, { reciprocalRank }) => total + reciprocalRank,
            0,
          ) / Math.max(1, count),
        recallAt5:
          outcomes.filter(({ recallAt5 }) => recallAt5).length /
          Math.max(1, count),
      };

      expect(report).toEqual({
        hitAt1: 1,
        meanReciprocalRank: 1,
        recallAt5: 1,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
