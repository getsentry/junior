import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverStaleDispatches } from "@/chat/agent-dispatch/heartbeat";
import {
  createOrGetDispatch,
  getDispatchRecord,
  getDispatchStorageKey,
  listIncompleteDispatchIds,
  updateDispatchRecord,
  withDispatchLock,
} from "@/chat/agent-dispatch/store";
import type { DispatchRecord } from "@/chat/agent-dispatch/types";
import {
  resetHeartbeatTestEnv,
  setupHeartbeatTestEnv,
} from "../fixtures/heartbeat";
import { getStateAdapter } from "@/chat/state/adapter";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("trusted plugin dispatch recovery", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await setupHeartbeatTestEnv();
  });

  afterEach(async () => {
    await resetHeartbeatTestEnv(originalFetch);
  });

  it("fails stale dispatches that exceed retry attempts", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-exhausted",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      },
    });
    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        attempt: record.maxAttempts,
        lastCallbackAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      });
    });

    await expect(
      recoverStaleDispatches({
        nowMs: Date.parse("2026-05-26T12:05:00.000Z"),
      }),
    ).resolves.toBe(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Dispatch exceeded retry attempts.",
    });
  });

  it("fails stale dispatches when the locked row no longer parses", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-exhausted-corrupt-row",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      },
    });
    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        attempt: record.maxAttempts,
        lastCallbackAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      });
    });

    const state = getStateAdapter();
    await state.connect();
    const storageKey = getDispatchStorageKey(created.record.id);
    const current = await state.get<DispatchRecord>(storageKey);
    if (!current) {
      throw new Error("Expected dispatch record to exist");
    }
    const corruptRecord = {
      ...(current as unknown as Record<string, unknown>),
    };
    delete corruptRecord.destination;
    const originalGet = state.get.bind(state);
    let recordReads = 0;
    state.get = (async (key: string) => {
      if (key === storageKey && recordReads++ === 1) {
        return corruptRecord;
      }
      return await originalGet(key);
    }) as typeof state.get;

    try {
      await expect(
        recoverStaleDispatches({
          nowMs: Date.parse("2026-05-26T12:05:00.000Z"),
        }),
      ).resolves.toBe(0);
    } finally {
      state.get = originalGet;
    }

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Dispatch exceeded retry attempts.",
    });
  });

  it("removes terminal dispatches from the recovery index", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-terminal-index",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      },
    });

    await expect(listIncompleteDispatchIds()).resolves.toContain(
      created.record.id,
    );

    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("missing dispatch record");
      }
      await updateDispatchRecord(state, {
        ...record,
        status: "completed",
      });
    });

    await expect(listIncompleteDispatchIds()).resolves.not.toContain(
      created.record.id,
    );
  });

  it("does not fail an active leased dispatch that reached max attempts", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-active-max-attempts",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      },
    });
    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        attempt: record.maxAttempts,
        lastCallbackAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
        leaseExpiresAtMs: Date.parse("2026-05-26T12:10:00.000Z"),
        status: "running",
      });
    });

    await expect(
      recoverStaleDispatches({
        nowMs: Date.parse("2026-05-26T12:05:00.000Z"),
      }),
    ).resolves.toBe(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "running",
      attempt: created.record.maxAttempts,
    });
  });
});
