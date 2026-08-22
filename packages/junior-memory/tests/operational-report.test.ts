import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  pgliteBtreeGinExtension,
  pgliteVectorExtension,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import * as memorySqlSchema from "../src/db/schema";
import { juniorMemoryMemories } from "../src/db/schema";
import { buildMemoryOperationalReport } from "../src/operational-report";
import { createMemoryStore, type MemoryDb } from "../src/store";

const TEST_NOW_MS = Date.parse("2026-07-28T12:00:00.000Z");
const __dirname = dirname(fileURLToPath(import.meta.url));

function emptyExtractionDays() {
  const start = Date.parse("2026-04-30T00:00:00.000Z");
  return Array.from({ length: 90 }, (_, index) => ({
    costUsd: 0,
    date: new Date(start + index * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10),
    events: 0,
  }));
}

type MemoryFixture = LocalPgliteFixture<MemoryDb>;

async function createMemoryFixture(): Promise<MemoryFixture> {
  const fixture = await createLocalPgliteFixture<MemoryDb>(memorySqlSchema, {
    extensions: {
      btree_gin: pgliteBtreeGinExtension,
      vector: pgliteVectorExtension,
    },
  });
  const migrations = (await readdir(resolve(__dirname, "../migrations")))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    await fixture.execute(
      await readFile(resolve(__dirname, "../migrations", migration), "utf8"),
    );
  }
  return fixture;
}

function localContext() {
  return {
    conversationId: "local:junior:memory-report",
    actor: { platform: "local" as const, userId: "report-user" },
    source: createLocalSource("local:junior:memory-report"),
  };
}

function testEmbedder() {
  return {
    async embedTexts(input: { texts: string[] }) {
      return {
        dimensions: 1536,
        model: "test-model",
        provider: "test-provider",
        vectors: input.texts.map(() => [
          1,
          ...Array.from({ length: 1535 }, () => 0),
        ]),
      };
    },
  };
}

describe("memory operational report", () => {
  it("keeps chart days in UTC when the database session uses another timezone", async () => {
    const fixture = await createMemoryFixture();
    try {
      await fixture.execute("SET TIME ZONE 'America/Los_Angeles'");
      await fixture
        .db()
        .insert(juniorMemoryMemories)
        .values({
          content: "A memory created shortly after UTC midnight.",
          createdAtMs: Date.parse("2026-07-28T00:30:00.000Z"),
          id: "utc-boundary-memory",
          kind: "knowledge",
          observedAtMs: Date.parse("2026-07-28T00:30:00.000Z"),
          scope: "private",
          scopeKey: "local:report-user",
          sourceKey: "local:junior:memory-report",
          sourcePlatform: "local",
          subjectKey: "report-user",
          subjectType: "user",
        });

      const report = await buildMemoryOperationalReport({
        db: fixture.db(),
        extractionDays: emptyExtractionDays(),
        nowMs: TEST_NOW_MS,
      });

      expect(report.widgets?.[1]?.categories).toHaveLength(90);
      expect(report.widgets?.[1]?.categories.at(-1)).toEqual({
        id: "2026-07-28",
        label: "2026-07-28",
        values: {
          conversation: 0,
          personal: 1,
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("reports an empty memory system", async () => {
    const fixture = await createMemoryFixture();
    try {
      const report = await buildMemoryOperationalReport({
        db: fixture.db(),
        extractionDays: emptyExtractionDays(),
        nowMs: TEST_NOW_MS,
      });
      expect(report).toMatchObject({
        generatedAt: "2026-07-28T12:00:00.000Z",
        title: "Memory",
        metrics: [
          {
            label: "active memories",
            tone: "neutral",
            value: "0",
          },
          { label: "extraction cost · 30d", value: "$0.00" },
          { label: "created · 30d", value: "0" },
          { label: "personal", value: "0" },
          { label: "conversation", value: "0" },
          {
            label: "embedding coverage",
            tone: "neutral",
            value: "0%",
          },
        ],
      });
      expect(report.widgets).toEqual([
        expect.objectContaining({
          id: "extraction-cost",
          series: [{ format: "usd", key: "costUsd", label: "Cost" }],
          timeRangeDays: [7, 30, 90],
          title: "Extraction cost",
          type: "bar_chart",
        }),
        expect.objectContaining({
          id: "memories-created",
          series: [
            { key: "personal", label: "Personal" },
            { key: "conversation", label: "Conversation" },
          ],
          timeRangeDays: [7, 30, 90],
          title: "Memories created",
          type: "bar_chart",
        }),
      ]);
      expect(report.widgets?.[0]?.categories).toHaveLength(90);
      expect(
        report.widgets?.[1]?.categories.every((day) => {
          return day.values.personal === 0 && day.values.conversation === 0;
        }),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("counts active scopes and embedding coverage without exposing contents", async () => {
    const fixture = await createMemoryFixture();
    try {
      const db = fixture.db();
      const store = createMemoryStore(db, localContext(), {
        embedder: testEmbedder(),
        now: () => TEST_NOW_MS,
      });
      await store.createMemory({
        content: "Use compact pull request summaries.",
        idempotencyKey: "report-personal",
        kind: "preference",
      });
      await store.createConversationMemory({
        content: "The checkout runbook lives in the service repository.",
        idempotencyKey: "report-conversation",
        kind: "procedure",
      });
      await db.insert(juniorMemoryMemories).values({
        archivedAtMs: TEST_NOW_MS,
        content: "Archived memory content.",
        createdAtMs: TEST_NOW_MS,
        id: "archived-memory",
        kind: "knowledge",
        observedAtMs: TEST_NOW_MS,
        scope: "private",
        scopeKey: "local:report-user",
        sourceKey: "local:junior:memory-report",
        sourcePlatform: "local",
        subjectKey: "report-user",
        subjectType: "user",
      });
      const extractionDays = emptyExtractionDays();
      extractionDays[89] = {
        costUsd: 0.0042,
        date: "2026-07-28",
        events: 4,
      };

      const report = await buildMemoryOperationalReport({
        db,
        extractionDays,
        nowMs: TEST_NOW_MS,
      });

      expect(report.metrics).toEqual([
        { label: "active memories", tone: "good", value: "2" },
        { label: "extraction cost · 30d", value: "$0.0042" },
        { label: "created · 30d", value: "3" },
        { label: "personal", value: "2" },
        { label: "conversation", value: "0" },
        { label: "embedding coverage", tone: "good", value: "100%" },
      ]);
      expect(report.widgets?.[1]?.categories.at(-1)).toEqual({
        id: "2026-07-28",
        label: "2026-07-28",
        values: {
          conversation: 0,
          personal: 3,
        },
      });
      expect(report.widgets?.[0]?.categories.at(-1)).toEqual({
        id: "2026-07-28",
        label: "2026-07-28",
        values: { costUsd: 0.0042 },
      });
      expect(JSON.stringify(report)).not.toContain("checkout");
      expect(JSON.stringify(report)).not.toContain("report-user");
    } finally {
      await fixture.close();
    }
  });
});
