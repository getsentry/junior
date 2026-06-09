import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_ACTIVE_INDEX_KEY,
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  requestConversationWork,
} from "@/chat/task-execution/store";
import type { PiMessage } from "@/chat/pi/messages";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { runUpgradeMigrations } from "@/cli/upgrade";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  inboundMessage,
} from "../../fixtures/conversation-work";

const ORIGINAL_ENV = vi.hoisted(() => {
  const original = {
    JUNIOR_STATE_ADAPTER: process.env.JUNIOR_STATE_ADAPTER,
  };
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  return original;
});
const OTHER_SLACK_DESTINATION = {
  ...SLACK_DESTINATION,
  channelId: "C999",
} as const;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function persistActiveTurn(
  conversationId: string,
  activeTurnId?: string,
): Promise<void> {
  await persistThreadStateById(conversationId, {
    conversation: {
      schemaVersion: 1,
      backfill: {},
      compactions: [],
      messages: [],
      piMessages: [],
      processing: {
        activeTurnId,
      },
      stats: {
        compactedMessageCount: 0,
        estimatedContextTokens: 0,
        totalMessageCount: 0,
        updatedAtMs: 2_000,
      },
      vision: {
        byFileId: {},
      },
    },
  });
}

describe("upgrade CLI migrations", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_ENV.JUNIOR_STATE_ADAPTER);
    vi.restoreAllMocks();
  });

  it("migrates legacy conversation work records into conversation records", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const legacyMessage = inboundMessage("m1");
    const legacyWork = {
      schemaVersion: 1,
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      lastEnqueuedAtMs: 1_500,
      messages: [legacyMessage],
      needsRun: true,
      updatedAtMs: 2_000,
    };
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      legacyWork,
    );
    await stateAdapter.set("junior:conversation-work:index", [
      CONVERSATION_ID,
      "missing-conversation",
    ]);
    const logs: string[] = [];

    const results = await runUpgradeMigrations({
      io: { info: (line) => logs.push(line) },
      stateAdapter,
    });

    expect(results).toEqual([
      {
        existing: 0,
        migrated: 1,
        missing: 1,
        scanned: 2,
      },
    ]);
    await expect(
      stateAdapter.get(`junior:conversation-work:state:${CONVERSATION_ID}`),
    ).resolves.toBeNull();
    await expect(
      stateAdapter.get("junior:conversation-work:index"),
    ).resolves.toBeNull();
    await expect(
      stateAdapter.get(`junior:conversation:${CONVERSATION_ID}`),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      conversationId: CONVERSATION_ID,
      createdAtMs: 1_000,
      destination: SLACK_DESTINATION,
      lastActivityAtMs: 1_100,
      source: "slack",
      updatedAtMs: 2_000,
      execution: {
        inboundMessageIds: ["m1"],
        lastEnqueuedAtMs: 1_500,
        pendingCount: 1,
        pendingMessages: [expect.objectContaining({ inboundMessageId: "m1" })],
        status: "pending",
        updatedAtMs: 2_000,
      },
    });
    await expect(
      stateAdapter.get(CONVERSATION_BY_ACTIVITY_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: 1_100,
      },
    ]);
    await expect(
      stateAdapter.get(CONVERSATION_ACTIVE_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: 2_000,
      },
    ]);
    expect(logs).toEqual([
      "Running migration migrate-redis-conversation-state...",
      "Finished migration migrate-redis-conversation-state: scanned=2 migrated=1 existing=0 missing=1",
    ]);
  });

  it("seeds active awaiting continuations into conversation work", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "finish this" }],
          timestamp: 1_000,
        } as PiMessage,
      ],
      resumeReason: "timeout",
      sessionId: "turn-timeout",
      sliceId: 2,
      state: "awaiting_resume",
    });
    await persistActiveTurn(CONVERSATION_ID, "turn-timeout");

    const results = await runUpgradeMigrations({
      io: { info: () => {} },
      stateAdapter,
    });

    expect(results).toEqual([
      {
        existing: 0,
        migrated: 1,
        missing: 0,
        scanned: 1,
      },
    ]);
    await expect(
      stateAdapter.get(`junior:conversation:${CONVERSATION_ID}`),
    ).resolves.toMatchObject({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      execution: {
        pendingCount: 0,
        pendingMessages: [],
        status: "pending",
      },
    });
    await expect(
      stateAdapter.get(CONVERSATION_ACTIVE_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: expect.any(Number),
      },
    ]);
  });

  it("merges legacy pending work when the conversation record already exists", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state: stateAdapter,
    });
    await stateAdapter.delete(CONVERSATION_BY_ACTIVITY_INDEX_KEY);
    await stateAdapter.delete(CONVERSATION_ACTIVE_INDEX_KEY);
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        messages: [inboundMessage("m1")],
        needsRun: true,
        updatedAtMs: 3_000,
      },
    );
    await stateAdapter.set("junior:conversation-work:index", [CONVERSATION_ID]);

    const results = await runUpgradeMigrations({
      io: { info: () => {} },
      stateAdapter,
    });

    expect(results).toEqual([
      {
        existing: 1,
        migrated: 0,
        missing: 0,
        scanned: 1,
      },
    ]);
    await expect(
      stateAdapter.get(`junior:conversation-work:state:${CONVERSATION_ID}`),
    ).resolves.toBeNull();
    await expect(
      stateAdapter.get(`junior:conversation:${CONVERSATION_ID}`),
    ).resolves.toMatchObject({
      conversationId: CONVERSATION_ID,
      lastActivityAtMs: 2_000,
      updatedAtMs: 3_000,
      execution: {
        inboundMessageIds: ["m1"],
        pendingCount: 1,
        pendingMessages: [expect.objectContaining({ inboundMessageId: "m1" })],
        status: "pending",
        updatedAtMs: 3_000,
      },
    });
    await expect(
      stateAdapter.get("junior:conversation-work:index"),
    ).resolves.toBeNull();
    await expect(
      stateAdapter.get(CONVERSATION_BY_ACTIVITY_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: 2_000,
      },
    ]);
    await expect(
      stateAdapter.get(CONVERSATION_ACTIVE_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: 3_000,
      },
    ]);
  });

  it("does not merge legacy pending work with a different destination", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state: stateAdapter,
    });
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        destination: OTHER_SLACK_DESTINATION,
        messages: [
          {
            ...inboundMessage("m1"),
            destination: OTHER_SLACK_DESTINATION,
          },
        ],
        needsRun: true,
        updatedAtMs: 3_000,
      },
    );
    await stateAdapter.set("junior:conversation-work:index", [CONVERSATION_ID]);

    await expect(
      runUpgradeMigrations({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).rejects.toThrow(
      `Legacy conversation work destination does not match conversation ${CONVERSATION_ID}`,
    );
    await expect(
      stateAdapter.get(`junior:conversation-work:state:${CONVERSATION_ID}`),
    ).resolves.toEqual(expect.objectContaining({ needsRun: true }));
  });

  it("rejects legacy pending work with a different message destination", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        messages: [
          {
            ...inboundMessage("m1"),
            destination: OTHER_SLACK_DESTINATION,
          },
        ],
        needsRun: true,
        updatedAtMs: 3_000,
      },
    );
    await stateAdapter.set("junior:conversation-work:index", [CONVERSATION_ID]);

    await expect(
      runUpgradeMigrations({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).rejects.toThrow(
      `Legacy conversation work state is invalid for ${CONVERSATION_ID}`,
    );
    await expect(
      stateAdapter.get(`junior:conversation-work:state:${CONVERSATION_ID}`),
    ).resolves.toEqual(expect.objectContaining({ needsRun: true }));
  });

  it("ignores malformed legacy conversation work indexes", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set("junior:conversation-work:index", {
      conversationId: CONVERSATION_ID,
    });

    await expect(
      runUpgradeMigrations({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).resolves.toEqual([
      {
        existing: 0,
        migrated: 0,
        missing: 0,
        scanned: 0,
      },
    ]);
  });
});
