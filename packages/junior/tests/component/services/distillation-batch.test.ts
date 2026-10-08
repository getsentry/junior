import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  finishBatch,
  pendingBatch,
  startObservationBatch,
} from "@/chat/distillation/task";
import { readConversationAuxiliaryCostsFromSql } from "@/api/conversations/auxiliary-costs";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

describe("Conversation observation batches", () => {
  let fixture: LocalJuniorSqlFixture;

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    await migrateSchema(fixture.sql);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("stores only a batch reference before scheduling a delayed result check", async () => {
    const store = createSqlConversationEventStore(fixture.sql);
    const conversationId = "local:batch:submitted";
    await store.append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          messageId: "first",
          role: "user",
          text: "private source text",
        },
      },
    ]);
    const requeue = vi.fn(async (seconds: number) => {
      expect(seconds).toBe(600);
      expect(
        pendingBatch(await store.loadHistory(conversationId), 0),
      ).toBeDefined();
    });
    const submit = vi.fn(async () => ({
      id: "batch-submitted",
      version: 2 as const,
      provider: "vercel-ai-gateway.batch",
    }));
    await expect(
      startObservationBatch({
        context: { requeue },
        conversationId,
        historyVersion: 0,
        segments: [
          [
            {
              seq: 1,
              provenance: { authority: "instruction" },
              message: {
                role: "user",
                content: [{ type: "text", text: "private source text" }],
                timestamp: Date.now(),
              },
            },
          ],
        ],
        store,
        client: { submit },
      }),
    ).resolves.toBe("started");
    expect(submit).toHaveBeenCalledOnce();
    expect(requeue).toHaveBeenCalledOnce();
    const batch = pendingBatch(await store.loadHistory(conversationId), 0);
    expect(batch?.data.requests).toEqual([
      { id: "segment:1:1", fromSeq: 1, throughSeq: 1 },
    ]);
    expect(JSON.stringify(batch?.data)).not.toContain("private source text");
  });

  it("commits out-of-order results together and never duplicates observations on retry", async () => {
    const store = createSqlConversationEventStore(fixture.sql);
    const conversationId = "local:batch:ordered";
    await store.append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          messageId: "first",
          role: "user",
          text: "work",
        },
      },
    ]);
    await store.append(conversationId, [
      {
        createdAtMs: Date.now(),
        data: {
          type: "distillation_batch",
          sourceHistoryVersion: 0,
          batchId: "batch-ordered",
          provider: "vercel-ai-gateway.batch",
          requests: [
            { id: "segment:1:2", fromSeq: 1, throughSeq: 2 },
            { id: "segment:3:4", fromSeq: 3, throughSeq: 4 },
          ],
        },
      },
    ]);
    const client = {
      status: async () => "completed" as const,
      results: async () => [
        {
          id: "segment:3:4",
          status: "succeeded" as const,
          text: "<observations>second</observations>",
          costUsd: 0.002,
        },
        {
          id: "segment:1:2",
          status: "succeeded" as const,
          text: "<observations>first</observations>",
          costUsd: 0.001,
        },
      ],
    };

    const batch = pendingBatch(await store.loadHistory(conversationId), 0);
    expect(batch).toBeDefined();
    await expect(
      finishBatch({ batch: batch!, conversationId, store, client }),
    ).resolves.toBe("processed");
    expect(
      pendingBatch(await store.loadHistory(conversationId), 0),
    ).toBeUndefined();
    await expect(
      finishBatch({ batch: batch!, conversationId, store, client }),
    ).resolves.toBe("processed");
    const observations = (await store.loadHistory(conversationId)).filter(
      (event) => event.data.type === "distillation",
    );
    expect(observations.map((event) => event.data)).toMatchObject([
      { fromSeq: 1, throughSeq: 2, observations: "first", costUsd: 0.001 },
      { fromSeq: 3, throughSeq: 4, observations: "second", costUsd: 0.002 },
    ]);
    const costs = await readConversationAuxiliaryCostsFromSql(
      fixture.sql.db(),
      [conversationId],
      { includeDescendants: false },
    );
    expect(costs.get(conversationId)?.costUsd).toBe(0.003);
  });

  it("keeps source history raw if any batch result is missing", async () => {
    const store = createSqlConversationEventStore(fixture.sql);
    const conversationId = "local:batch:partial";
    await store.append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          messageId: "first",
          role: "user",
          text: "work",
        },
      },
    ]);
    await store.append(conversationId, [
      {
        createdAtMs: Date.now(),
        data: {
          type: "distillation_batch",
          sourceHistoryVersion: 0,
          batchId: "batch-partial",
          provider: "vercel-ai-gateway.batch",
          requests: [
            { id: "segment:1:2", fromSeq: 1, throughSeq: 2 },
            { id: "segment:3:4", fromSeq: 3, throughSeq: 4 },
          ],
        },
      },
    ]);
    const client = {
      status: async () => "completed" as const,
      results: async () => [
        {
          id: "segment:1:2",
          status: "succeeded" as const,
          text: "<observations>first</observations>",
          costUsd: 0.001,
          costEstimated: true,
        },
      ],
    };

    const batch = pendingBatch(await store.loadHistory(conversationId), 0);
    expect(batch).toBeDefined();
    await expect(
      finishBatch({ batch: batch!, conversationId, store, client }),
    ).resolves.toBe("failed");
    const events = await store.loadHistory(conversationId);
    expect(events.some((event) => event.data.type === "distillation")).toBe(
      false,
    );
    expect(events.at(-1)?.data).toMatchObject({
      type: "distillation_batch_done",
      outcome: "failed",
      costUsd: 0.001,
      costEstimated: true,
    });
    const costs = await readConversationAuxiliaryCostsFromSql(
      fixture.sql.db(),
      [conversationId],
      { includeDescendants: false },
    );
    expect(costs.get(conversationId)?.costUsd).toBe(0.001);
    expect(costs.get(conversationId)?.estimatedCostUsd).toBe(0.001);
  });

  it("stops retrying an expired batch without claiming unreported costs", async () => {
    const store = createSqlConversationEventStore(fixture.sql);
    const conversationId = "local:batch:expired";
    await store.append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          messageId: "first",
          role: "user",
          text: "work",
        },
      },
    ]);
    await store.append(conversationId, [
      {
        createdAtMs: Date.now() - 24 * 60 * 60 * 1_000,
        data: {
          type: "distillation_batch",
          sourceHistoryVersion: 0,
          batchId: "batch-expired",
          provider: "vercel-ai-gateway.batch",
          requests: [{ id: "segment:1:2", fromSeq: 1, throughSeq: 2 }],
        },
      },
    ]);
    const status = vi.fn();
    const results = vi.fn();
    const batch = pendingBatch(await store.loadHistory(conversationId), 0);
    expect(batch).toBeDefined();
    await expect(
      finishBatch({
        batch: batch!,
        conversationId,
        store,
        client: { status, results },
      }),
    ).resolves.toBe("failed");
    expect(status).not.toHaveBeenCalled();
    expect(results).not.toHaveBeenCalled();
    expect((await store.loadHistory(conversationId)).at(-1)?.data).toEqual({
      type: "distillation_batch_done",
      sourceHistoryVersion: 0,
      batchId: "batch-expired",
      outcome: "failed",
    });
  });

  it("records a stale batch charge without inserting observations into replaced history", async () => {
    const store = createSqlConversationEventStore(fixture.sql);
    const conversationId = "local:batch:replaced";
    await store.append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          messageId: "first",
          role: "user",
          text: "work",
        },
      },
    ]);
    await store.replaceHistory(conversationId, {
      createdAtMs: Date.now(),
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "openai/gpt-6-luna",
        summary: "replacement",
        replacementHistory: [],
      },
    });
    await store.append(conversationId, [
      {
        createdAtMs: Date.now(),
        data: {
          type: "distillation_batch",
          sourceHistoryVersion: 0,
          batchId: "batch-replaced",
          provider: "vercel-ai-gateway.batch",
          requests: [{ id: "segment:1:1", fromSeq: 1, throughSeq: 1 }],
        },
      },
    ]);
    const batch = pendingBatch(await store.loadHistory(conversationId));
    expect(batch).toBeDefined();
    await expect(
      finishBatch({
        batch: batch!,
        conversationId,
        store,
        client: {
          status: async () => "completed",
          results: async () => [
            {
              id: "segment:1:1",
              status: "succeeded",
              text: "<observations>work</observations>",
              costUsd: 0.001,
            },
          ],
        },
      }),
    ).resolves.toBe("failed");
    expect(
      pendingBatch(await store.loadHistory(conversationId)),
    ).toBeUndefined();
    const current = await store.loadCurrentHistory(conversationId);
    expect(current.some((event) => event.data.type === "distillation")).toBe(
      false,
    );
    expect(current.at(-1)?.data).toMatchObject({
      type: "distillation_batch_done",
      sourceHistoryVersion: 0,
      batchId: "batch-replaced",
      outcome: "failed",
      costUsd: 0.001,
    });
    const costs = await readConversationAuxiliaryCostsFromSql(
      fixture.sql.db(),
      [conversationId],
      { includeDescendants: false },
    );
    expect(costs.get(conversationId)?.costUsd).toBe(0.001);
  });
});
